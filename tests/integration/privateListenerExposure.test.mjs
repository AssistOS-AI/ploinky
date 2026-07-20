import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';

import { createPrivateListener, PRIVATE_LISTENER_HOST } from '../../cli/server/privateListener.js';

function request(host, port, requestPath) {
    return new Promise((resolve, reject) => {
        http.get({ host, port, path: requestPath, timeout: 1000 }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        }).on('error', reject);
    });
}

function connect(host, port) {
    return new Promise(resolve => {
        const socket = net.connect({ host, port });
        const finish = value => { socket.destroy(); resolve(value); };
        socket.setTimeout(750, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
    });
}

test('private listener is reachable on loopback and unreachable on non-loopback host interfaces', async (t) => {
    const server = await createPrivateListener({
        port: 0,
        handler: (_req, res) => res.end('private-ok'),
        proveBinding: async () => true,
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const address = server.address();
    assert.equal(address.address, PRIVATE_LISTENER_HOST);
    assert.deepEqual(await request('127.0.0.1', address.port, '/control'), { status: 200, body: 'private-ok' });
    const external = Object.values(os.networkInterfaces()).flat().find(item => item?.family === 'IPv4' && !item.internal)?.address;
    if (!external) return t.skip('no non-loopback IPv4 interface available');
    assert.equal(await connect(external, address.port), false);
});
