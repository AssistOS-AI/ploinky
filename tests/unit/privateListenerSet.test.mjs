import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';

import {
    classifyPrivateListenerRequest,
    createPrivateListenerSet,
} from '../../cli/server/privateListenerSet.js';

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen({ host: '0.0.0.0', port: 0 }, () => {
            const { port } = probe.address();
            probe.close((error) => error ? reject(error) : resolve(port));
        });
    });
}

function exactNonLoopbackAddress() {
    for (const records of Object.values(os.networkInterfaces())) {
        for (const record of records || []) {
            if (record.family === 'IPv4' && !record.internal && net.isIP(record.address) === 4) {
                return record.address;
            }
        }
    }
    throw new Error('private-listener tests require one configured non-loopback IPv4 interface');
}

function request(address, port) {
    return new Promise((resolve, reject) => {
        const req = http.get({
            host: address,
            port,
            path: '/',
            agent: false,
            headers: { Host: 'host.containers.internal:8081' },
        }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.once('error', reject);
    });
}

function fakeClassifier(initialGateways = []) {
    let gateways = new Set(initialGateways);
    let lastError = '';
    return {
        refresh() {},
        classify(address) {
            if (address === '127.0.0.1') return 'loopback';
            return gateways.has(address) && !lastError ? 'managed' : 'unmanaged';
        },
        snapshot() {
            return { gateways: lastError ? [] : [...gateways], lastError, refreshedAt: Date.now() };
        },
        replace(next) {
            gateways = new Set(next);
            lastError = '';
        },
        fail(message) {
            gateways = new Set();
            lastError = message;
        },
    };
}

test('private listener set binds loopback and exact current gateways without a wildcard', async (t) => {
    const port = await freePort();
    const gateway = exactNonLoopbackAddress();
    const classifier = fakeClassifier([gateway]);
    const observed = [];
    const httpServer = http.createServer((req, res) => {
        observed.push(req.socket.localAddress);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(req.socket.localAddress);
    });
    const listenerSet = createPrivateListenerSet({
        httpServer,
        interfaceClassifier: classifier,
        port,
        refreshIntervalMs: 60_000,
    });
    t.after(() => listenerSet.close());

    assert.deepEqual((await listenerSet.start()).addresses, ['127.0.0.1', gateway].sort());
    assert.deepEqual((await request('127.0.0.1', port)), { status: 200, body: '127.0.0.1' });
    assert.deepEqual((await request(gateway, port)), { status: 200, body: gateway });

    classifier.replace([]);
    assert.deepEqual((await listenerSet.sync()).addresses, ['127.0.0.1']);
    await assert.rejects(() => request(gateway, port));
    classifier.replace([gateway]);
    assert.deepEqual((await listenerSet.sync()).addresses, ['127.0.0.1', gateway].sort());
    assert.deepEqual((await request(gateway, port)), { status: 200, body: gateway });

    classifier.fail('managed network inspection failed');
    const failedClosed = await listenerSet.sync();
    assert.deepEqual(failedClosed.addresses, ['127.0.0.1']);
    assert.equal(failedClosed.lastError, 'managed network inspection failed');
    await assert.rejects(() => request(gateway, port));
    assert.deepEqual(observed, ['127.0.0.1', gateway, gateway]);
});

test('private listener startup rejects and closes partial binds when a managed gateway is occupied', async (t) => {
    const port = await freePort();
    const gateway = exactNonLoopbackAddress();
    const blocker = net.createServer();
    await new Promise((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen({ host: gateway, port }, resolve);
    });
    t.after(() => new Promise((resolve) => blocker.close(resolve)));

    const listenerSet = createPrivateListenerSet({
        httpServer: http.createServer((_req, res) => res.end('unexpected')),
        interfaceClassifier: fakeClassifier([gateway]),
        port,
        refreshIntervalMs: 60_000,
    });
    await assert.rejects(
        () => listenerSet.start(),
        (error) => error?.code === 'PRIVATE_LISTENER_SET_INCOMPLETE'
            && /exact listener set is incomplete/.test(error.message),
    );
    assert.deepEqual(listenerSet.snapshot().addresses, []);
    await assert.rejects(() => request('127.0.0.1', port));
});

test('Box private listener uses one unpublished wildcard socket and relies on assertion admission', async (t) => {
    const port = await freePort();
    const nonLoopbackAddress = exactNonLoopbackAddress();
    const classifier = fakeClassifier([]);
    const observed = [];
    const httpServer = http.createServer((req, res) => {
        observed.push({
            admittedClass: classifyPrivateListenerRequest(req),
            interfaceClass: classifier.classify(req.socket.localAddress),
            localAddress: req.socket.localAddress,
        });
        res.end('box-private');
    });
    const scheduled = [];
    let activeTimer = null;
    const listenerSet = createPrivateListenerSet({
        httpServer,
        interfaceClassifier: classifier,
        port,
        wildcardHost: true,
        refreshIntervalMs: 60_000,
        schedule(callback, delay) {
            assert.equal(activeTimer, null, 'only one reconciliation timer may be active');
            activeTimer = { callback, delay, unref() {} };
            scheduled.push(activeTimer);
            return activeTimer;
        },
        cancelSchedule(timer) {
            if (activeTimer === timer) activeTimer = null;
        },
    });
    t.after(() => listenerSet.close());

    assert.deepEqual((await listenerSet.start()).addresses, ['0.0.0.0']);
    assert.equal(scheduled.length, 1);
    assert.deepEqual(await request('127.0.0.1', port), { status: 200, body: 'box-private' });
    assert.deepEqual(await request(nonLoopbackAddress, port), { status: 200, body: 'box-private' });
    assert.deepEqual(observed, [{
        admittedClass: 'private',
        interfaceClass: 'loopback',
        localAddress: '127.0.0.1',
    }, {
        admittedClass: 'private',
        interfaceClass: 'unmanaged',
        localAddress: nonLoopbackAddress,
    }]);
    assert.equal(classifyPrivateListenerRequest({
        socket: {
            localAddress: nonLoopbackAddress,
        },
    }), 'denied');
    assert.deepEqual((await listenerSet.sync()).addresses, ['0.0.0.0']);

    const firstTimer = activeTimer;
    activeTimer = null;
    firstTimer.callback();
    assert.equal(scheduled.length, 1, 'next timer must wait for reconciliation to settle');
    await listenerSet.sync();
    assert.equal(scheduled.length, 2);
    assert.equal(activeTimer, scheduled[1]);
});

test('an ordinary listener socket cannot inherit private provenance from its address', async (t) => {
    const port = await freePort();
    const address = exactNonLoopbackAddress();
    const server = http.createServer((req, res) => {
        res.end(classifyPrivateListenerRequest(req));
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: address, port }, resolve);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));

    assert.deepEqual(await request(address, port), { status: 200, body: 'denied' });
});
