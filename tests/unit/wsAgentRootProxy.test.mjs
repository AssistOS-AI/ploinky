import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { Duplex } from 'node:stream';

import { handleAgentRootUpgrade } from '../../cli/server/wsAgentRootProxy.js';

function noUncaught(t) {
    const uncaught = [];
    const onUncaught = error => { uncaught.push(error); };
    const previousListeners = process.listeners('uncaughtException');
    for (const listener of previousListeners) process.removeListener('uncaughtException', listener);
    process.on('uncaughtException', onUncaught);
    t.after(() => {
        process.removeListener('uncaughtException', onUncaught);
        for (const listener of previousListeners) process.on('uncaughtException', listener);
    });
    return uncaught;
}

// A target that accepts the WebSocket handshake only after a delay, so the
// client can disappear while the Router is still waiting for the upstream.
async function delayedTarget(t, delayMs) {
    const sockets = [];
    const closed = [];
    const server = http.createServer();
    server.on('upgrade', (req, socket) => {
        sockets.push(socket);
        // http.Server allows half-open sockets: the peer's FIN surfaces as 'end'.
        closed.push(new Promise(resolve => { socket.once('end', resolve); socket.once('close', resolve); }));
        socket.on('error', () => {});
        setTimeout(() => {
            if (!socket.destroyed) socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
        }, delayMs);
    });
    t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { port: server.address().port, sockets, closed };
}

function agentRootPlan(port) {
    return {
        matched: true,
        ok: true,
        kind: 'agent-root',
        decision: { access: 'public' },
        target: { hostPort: port },
        upstreamPath: '/ws',
        lease: { commit: () => true },
    };
}

function upgradeRequest() {
    return {
        method: 'GET',
        url: '/ws',
        headers: {
            host: '127.0.0.1:8080',
            connection: 'Upgrade',
            upgrade: 'websocket',
            'sec-websocket-version': '13',
            'sec-websocket-key': Buffer.alloc(16, 5).toString('base64'),
        },
    };
}

test('client reset during the agent-root handshake wait is not uncaught', { concurrency: false }, async t => {
    const uncaught = noUncaught(t);
    const target = await delayedTarget(t, 250);
    const router = http.createServer();
    router.on('upgrade', (req, socket, head) => {
        // Mirrors the Router: the handler adds no client-socket listener.
        handleAgentRootUpgrade({
            req,
            socket,
            head,
            parsedUrl: new URL('http://127.0.0.1:8080/ws'),
            routePlan: agentRootPlan(target.port),
        });
    });
    t.after(() => router.close());
    await new Promise(resolve => router.listen(0, '127.0.0.1', resolve));
    const client = net.connect(router.address().port, '127.0.0.1');
    await new Promise(resolve => client.once('connect', resolve));
    client.write([
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${router.address().port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${Buffer.alloc(16, 5).toString('base64')}`,
        '',
        '',
    ].join('\r\n'));
    await new Promise(resolve => setTimeout(resolve, 80));
    client.resetAndDestroy();
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.deepEqual(uncaught.map(error => error.message), []);
});

test('client destroyed before the upstream upgrade writes no 101 and destroys the target socket', { concurrency: false }, async t => {
    const uncaught = noUncaught(t);
    const target = await delayedTarget(t, 150);
    const written = [];
    const socket = new Duplex({
        read() {},
        write(chunk, _encoding, callback) { written.push(Buffer.from(chunk)); callback(); },
    });
    const handled = await handleAgentRootUpgrade({
        req: upgradeRequest(),
        socket,
        head: Buffer.alloc(0),
        parsedUrl: new URL('http://127.0.0.1:8080/ws'),
        routePlan: agentRootPlan(target.port),
    });
    assert.equal(handled, true);
    await new Promise(resolve => setTimeout(resolve, 30));
    socket.destroy();
    await new Promise(resolve => setTimeout(resolve, 250));
    await Promise.race([
        Promise.all(target.closed),
        new Promise((_, reject) => setTimeout(() => reject(new Error('target socket was not destroyed')), 1000)),
    ]);
    assert.deepEqual(uncaught.map(error => error.message), []);
    assert.equal(Buffer.concat(written).toString('utf8').includes('101'), false);
});
