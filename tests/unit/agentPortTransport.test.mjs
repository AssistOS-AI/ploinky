import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { Readable, Writable } from 'node:stream';

import { executeHttpPlan } from '../../cli/server/proxy/executeHttpPlan.js';
import { compileProxyLimits } from '../../cli/server/proxy/limits.js';
import { createRoutePlan } from '../../cli/server/proxy/RoutePlan.js';

class ApplicationRelayStream extends EventEmitter {
    constructor() {
        super();
        this.channel = { child: { stdin: new EventEmitter() } };
        this.request = Buffer.alloc(0);
        this.responded = false;
    }

    write(chunk) {
        this.request = Buffer.concat([this.request, Buffer.from(chunk)]);
        const headerEnd = this.request.indexOf(Buffer.from('\r\n\r\n'));
        if (headerEnd >= 0 && !this.responded) {
            const header = this.request.subarray(0, headerEnd).toString('latin1');
            const length = Number(header.match(/content-length:\s*(\d+)/i)?.[1] || 0);
            if (this.request.length >= headerEnd + 4 + length) {
                this.responded = true;
                setImmediate(() => {
                    this.emit('data', Buffer.from([
                        'HTTP/1.1 200 OK',
                        'Content-Type: application/json',
                        'Content-Length: 11',
                        'Connection: close',
                        '',
                        '{"ok":true}',
                    ].join('\r\n')));
                    this.emit('end');
                });
            }
        }
        return true;
    }

    end() {}
    cancel() { this.emit('end'); }
}

class Response extends Writable {
    constructor() {
        super();
        this.statusCode = 0;
        this.headers = {};
        this.body = Buffer.alloc(0);
        this.headersSent = false;
    }

    writeHead(statusCode, headers) {
        this.statusCode = statusCode;
        this.headers = headers;
        this.headersSent = true;
    }

    _write(chunk, _encoding, callback) {
        this.body = Buffer.concat([this.body, Buffer.from(chunk)]);
        callback();
    }
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function settleWithin(promise, milliseconds = 100) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('handler did not settle promptly')), milliseconds);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function flushTurn() {
    return new Promise(resolve => setImmediate(resolve));
}

function routePlan({ allowRequestStreaming = false, limitOverrides = {} } = {}) {
    return createRoutePlan({
        matched: true,
        ok: true,
        listenerClass: 'public',
        authority: '127.0.0.1:8080',
        surfaceKind: 'agent-port-convention',
        owner: {
            effectiveInstanceId: 'alpha-instance',
            enableGeneration: 'alpha-enable-generation',
        },
        routeKey: 'alpha',
        port: 7001,
        policyPath: '/base-agent-additional-server/alpha/7001/api/items',
        convention: 'base-agent-additional-server',
        unmatchedSuffix: '/api/items',
        query: 'page=2',
        relay: {
            kind: 'container-exec-stdio',
            runtime: 'podman',
            containerId: 'a'.repeat(64),
            containerName: 'alpha-container',
            targetAgentId: 'agent:fixtures/alpha',
            effectiveInstanceId: 'alpha-instance',
            enableGeneration: 'alpha-enable-generation',
        },
        access: { access: 'authenticated' },
        scheme: 'http',
        origin: 'http://127.0.0.1:8080',
        forwardedPrefix: '/base-agent-additional-server/alpha/7001',
        limits: compileProxyLimits(limitOverrides),
        generationDigest: 'sha256:generation',
        auditId: 'audit-http',
        method: 'POST',
        transport: 'http',
        allowRequestStreaming,
        credentialPolicy: {
            allowApplicationAuthorization: true,
            allowApplicationCookies: true,
        },
        responsePolicy: {
            allowApplicationCookies: true,
            allowRedirects: true,
            allowCaching: true,
        },
    });
}

test('HTTP relay uses the admitted convention suffix, port, query, and exact body', async () => {
    const body = Buffer.from('{"name":"one"}');
    const request = Readable.from([body]);
    request.method = 'POST';
    request.headers = {
        host: '127.0.0.1:8080',
        'content-type': 'application/json',
    };
    const response = new Response();
    let opened;
    let released = false;
    const relayManager = {
        checkout: async ({ authorized }) => {
            assert.equal(authorized, true);
            return {
                openRequest: async options => {
                    opened = options;
                    return new ApplicationRelayStream();
                },
                close() {},
            };
        },
    };

    const handled = await executeHttpPlan({
        req: request,
        res: response,
        plan: routePlan(),
        lease: { release() { released = true; } },
        relayManager,
        authorized: true,
    });

    assert.equal(handled, true);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.toString('utf8'), '{"ok":true}');
    assert.equal(opened.plan.targetPath, '/api/items');
    assert.equal(opened.plan.port, 7001);
    assert.equal(opened.plan.query, 'page=2');
    assert.equal(opened.bodyMode, 'buffered');
    assert.match(opened.bodyHash, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(opened.headers.host, '127.0.0.1:7001');
    assert.equal(opened.headers['x-forwarded-prefix'], '/base-agent-additional-server/alpha/7001');
    assert.equal(released, true);
});

test('prebuffered private request bodies take precedence over route streaming', async () => {
    const body = Buffer.from('{"room":"diagnostic-room"}');
    const request = Readable.from([]);
    request.method = 'POST';
    request.headers = {
        host: 'host.containers.internal:8081',
        'content-type': 'application/json',
        'content-length': String(body.length),
    };
    const response = new Response();
    let opened;
    let relayStream;
    const relayManager = {
        checkout: async () => ({
            openRequest: async options => {
                opened = options;
                relayStream = new ApplicationRelayStream();
                return relayStream;
            },
            close() {},
        }),
    };

    const handled = await executeHttpPlan({
        req: request,
        res: response,
        plan: routePlan({ allowRequestStreaming: true }),
        lease: { release() {} },
        relayManager,
        authorized: true,
        prebufferedBody: body,
    });

    assert.equal(handled, true);
    assert.equal(response.statusCode, 200);
    assert.equal(opened.bodyMode, 'buffered');
    assert.equal(opened.headers['content-length'], String(body.length));
    assert.equal(
        relayStream.request.subarray(relayStream.request.indexOf(Buffer.from('\r\n\r\n')) + 4).toString('utf8'),
        body.toString('utf8'),
    );
});

test('client abort during relay checkout closes the acquired checkout without opening a request', {
    concurrency: false,
}, async t => {
    const request = Readable.from([]);
    request.method = 'POST';
    request.headers = { host: '127.0.0.1:8080' };
    const response = new Response();
    const checkoutStarted = deferred();
    const checkoutResult = deferred();
    let checkoutClosed = false;
    let opened = false;
    let released = false;
    let upstreamRequests = 0;
    const originalRequest = http.request;
    t.after(() => { http.request = originalRequest; });
    http.request = () => {
        upstreamRequests += 1;
        throw new Error('unexpected upstream HTTP request');
    };
    const relayManager = {
        checkout: async () => {
            checkoutStarted.resolve();
            return checkoutResult.promise;
        },
    };
    const checkout = {
        async openRequest() {
            opened = true;
            return new ApplicationRelayStream();
        },
        close() { checkoutClosed = true; },
    };

    const handling = executeHttpPlan({
        req: request,
        res: response,
        plan: routePlan(),
        lease: { release() { released = true; } },
        relayManager,
        authorized: true,
        prebufferedBody: Buffer.alloc(0),
    });
    await checkoutStarted.promise;
    request.emit('aborted');

    assert.equal(await settleWithin(handling), false);
    assert.equal(opened, false);
    assert.equal(upstreamRequests, 0);
    assert.equal(checkoutClosed, false);
    assert.equal(released, true);

    checkoutResult.resolve(checkout);
    await flushTurn();
    assert.equal(checkoutClosed, true);
});

test('downstream close during relay request setup cancels the checkout before HTTP is sent', {
    concurrency: false,
}, async t => {
    const request = Readable.from([]);
    request.method = 'POST';
    request.headers = { host: '127.0.0.1:8080' };
    const response = new Response();
    const openStarted = deferred();
    const openResult = deferred();
    const relayStream = new ApplicationRelayStream();
    let checkoutClosed = false;
    let relayCancelled = false;
    let released = false;
    let upstreamRequests = 0;
    let responseWrites = 0;
    let activeStream;
    const originalRequest = http.request;
    t.after(() => { http.request = originalRequest; });
    http.request = () => {
        upstreamRequests += 1;
        throw new Error('unexpected upstream HTTP request');
    };
    response.writeHead = () => { responseWrites += 1; };
    relayStream.cancel = () => { relayCancelled = true; };
    const checkout = {
        async openRequest() {
            openStarted.resolve();
            const stream = await openResult.promise;
            if (checkoutClosed) {
                stream.cancel();
                throw new Error('checkout closed while opening request');
            }
            activeStream = stream;
            return stream;
        },
        close() {
            if (checkoutClosed) return;
            checkoutClosed = true;
            activeStream?.cancel();
        },
    };
    const relayManager = {
        checkout: async () => checkout,
    };

    const handling = executeHttpPlan({
        req: request,
        res: response,
        plan: routePlan(),
        lease: { release() { released = true; } },
        relayManager,
        authorized: true,
        prebufferedBody: Buffer.alloc(0),
    });
    await openStarted.promise;
    const responseClosed = new Promise(resolve => response.once('close', resolve));
    response.destroy();
    await responseClosed;

    assert.equal(await settleWithin(handling), false);
    assert.equal(relayStream.request.length, 0);
    assert.equal(upstreamRequests, 0);
    assert.equal(responseWrites, 0);
    assert.equal(checkoutClosed, true);
    assert.equal(released, true);
    assert.equal(relayCancelled, false);

    openResult.resolve(relayStream);
    await flushTurn();
    assert.equal(relayCancelled, true);
});

test('client abort settles while trusted header setup remains unresolved', async () => {
    const request = Readable.from([]);
    request.method = 'POST';
    request.headers = { host: '127.0.0.1:8080' };
    const response = new Response();
    const factoryStarted = deferred();
    const factoryResult = deferred();
    let checkoutCalled = false;
    let released = false;
    const handling = executeHttpPlan({
        req: request,
        res: response,
        plan: routePlan(),
        lease: { release() { released = true; } },
        relayManager: {
            checkout: async () => {
                checkoutCalled = true;
                throw new Error('unexpected checkout');
            },
        },
        authorized: true,
        prebufferedBody: Buffer.alloc(0),
        trustedHeadersFactory: async () => {
            factoryStarted.resolve();
            return factoryResult.promise;
        },
    });
    await factoryStarted.promise;
    request.emit('aborted');

    assert.equal(await settleWithin(handling), false);
    assert.equal(checkoutCalled, false);
    assert.equal(released, true);

    factoryResult.reject(new Error('late trusted-header failure'));
    await flushTurn();
});

test('absolute response-header deadline terminates unresolved setup', async () => {
    const request = Readable.from([]);
    request.method = 'POST';
    request.headers = { host: '127.0.0.1:8080' };
    const response = new Response();
    const factoryStarted = deferred();
    const factoryResult = deferred();
    let checkoutCalled = false;
    let released = false;
    const handling = executeHttpPlan({
        req: request,
        res: response,
        plan: routePlan({ limitOverrides: { connectTimeoutMs: 5, headerTimeoutMs: 25 } }),
        lease: { release() { released = true; } },
        relayManager: {
            checkout: async () => {
                checkoutCalled = true;
                throw new Error('unexpected checkout');
            },
        },
        authorized: true,
        prebufferedBody: Buffer.alloc(0),
        trustedHeadersFactory: async () => {
            factoryStarted.resolve();
            return factoryResult.promise;
        },
    });
    await factoryStarted.promise;

    assert.equal(await settleWithin(handling, 200), false);
    assert.equal(response.statusCode, 504);
    assert.deepEqual(JSON.parse(response.body.toString('utf8')), { error: 'upstream_timeout' });
    assert.equal(checkoutCalled, false);
    assert.equal(released, true);

    factoryResult.resolve({});
    await flushTurn();
});

test('synchronous trusted-header work cannot bypass the absolute response-header deadline', async () => {
    const request = Readable.from([]);
    request.method = 'POST';
    request.headers = { host: '127.0.0.1:8080' };
    const response = new Response();
    let checkoutCalled = false;
    let released = false;
    const handled = await executeHttpPlan({
        req: request,
        res: response,
        plan: routePlan({ limitOverrides: { connectTimeoutMs: 1, headerTimeoutMs: 5 } }),
        lease: { release() { released = true; } },
        relayManager: {
            checkout: async () => {
                checkoutCalled = true;
                throw new Error('unexpected checkout');
            },
        },
        authorized: true,
        prebufferedBody: Buffer.alloc(0),
        trustedHeadersFactory: () => {
            const blockedUntil = Date.now() + 30;
            while (Date.now() < blockedUntil) {}
            return {};
        },
    });

    assert.equal(handled, false);
    assert.equal(response.statusCode, 504);
    assert.equal(checkoutCalled, false);
    assert.equal(released, true);
});

test('expired deadline prevents trusted-header setup after synchronous body preparation', async () => {
    const request = Readable.from([]);
    request.method = 'POST';
    request.headers = { host: '127.0.0.1:8080' };
    const response = new Response();
    let factoryCalled = false;
    let checkoutCalled = false;
    let released = false;
    const delayedBody = {
        valueOf() {
            const blockedUntil = Date.now() + 30;
            while (Date.now() < blockedUntil) {}
            return Buffer.alloc(0);
        },
    };
    const handled = await executeHttpPlan({
        req: request,
        res: response,
        plan: routePlan({ limitOverrides: { connectTimeoutMs: 1, headerTimeoutMs: 5 } }),
        lease: { release() { released = true; } },
        relayManager: {
            checkout: async () => {
                checkoutCalled = true;
                throw new Error('unexpected checkout');
            },
        },
        authorized: true,
        prebufferedBody: delayedBody,
        trustedHeadersFactory: () => {
            factoryCalled = true;
            return {};
        },
    });

    assert.equal(handled, false);
    assert.equal(response.statusCode, 504);
    assert.equal(factoryCalled, false);
    assert.equal(checkoutCalled, false);
    assert.equal(released, true);
});

test('buffered-body deadline removes listeners and closes the request after flushing 504', async () => {
    const request = new Readable({ read() {} });
    request.method = 'POST';
    request.headers = { host: '127.0.0.1:8080' };
    const response = new Response();
    let checkoutCalled = false;
    let released = false;
    const handling = executeHttpPlan({
        req: request,
        res: response,
        plan: routePlan({ limitOverrides: { connectTimeoutMs: 5, headerTimeoutMs: 25 } }),
        lease: { release() { released = true; } },
        relayManager: {
            checkout: async () => {
                checkoutCalled = true;
                throw new Error('unexpected checkout');
            },
        },
        authorized: true,
    });

    assert.equal(await settleWithin(handling, 200), false);
    await flushTurn();
    assert.equal(response.statusCode, 504);
    assert.equal(response.headers.connection, 'close');
    assert.deepEqual(JSON.parse(response.body.toString('utf8')), { error: 'upstream_timeout' });
    assert.equal(request.destroyed, true);
    assert.equal(request.listenerCount('data'), 0);
    assert.equal(request.listenerCount('end'), 0);
    assert.equal(request.listenerCount('aborted'), 0);
    assert.equal(request.listenerCount('error'), 0);
    assert.equal(checkoutCalled, false);
    assert.equal(released, true);
});

test('response-header deadline includes setup time instead of restarting at the upstream request', async () => {
    const request = Readable.from([]);
    request.method = 'POST';
    request.headers = { host: '127.0.0.1:8080' };
    const response = new Response();
    const upstreamStarted = deferred();
    const relayStream = new ApplicationRelayStream();
    relayStream.responded = true;
    const relayWrite = relayStream.write.bind(relayStream);
    relayStream.write = chunk => {
        upstreamStarted.resolve();
        return relayWrite(chunk);
    };
    let checkoutClosed = false;
    let released = false;
    const handling = executeHttpPlan({
        req: request,
        res: response,
        plan: routePlan({ limitOverrides: { connectTimeoutMs: 5, headerTimeoutMs: 240 } }),
        lease: { release() { released = true; } },
        relayManager: {
            checkout: async () => ({
                openRequest: async () => relayStream,
                close() { checkoutClosed = true; },
            }),
        },
        authorized: true,
        prebufferedBody: Buffer.alloc(0),
        trustedHeadersFactory: async () => {
            await new Promise(resolve => setTimeout(resolve, 160));
            return {};
        },
    });
    await upstreamStarted.promise;

    assert.equal(await settleWithin(handling, 140), false);
    assert.equal(response.statusCode, 504);
    assert.equal(checkoutClosed, true);
    assert.equal(released, true);
});
