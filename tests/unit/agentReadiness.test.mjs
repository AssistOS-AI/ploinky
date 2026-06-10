import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { waitForAgentReady } from '../../cli/server/utils/agentReadiness.js';

function listenOnEphemeralPort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer((socket) => {
            // Accept and immediately drop connections; the readiness probe
            // only needs the TCP handshake to succeed for protocol 'tcp'.
            socket.destroy();
        });
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, port });
        });
    });
}

function findFreePort() {
    // Open a server to reserve a port number, then close it so the port is
    // (almost certainly) free and refusing connections for the test.
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close((err) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(port);
            });
        });
    });
}

test('waitForAgentReady resolves true when the host port is open (tcp)', async () => {
    const { server, port } = await listenOnEphemeralPort();
    try {
        const ready = await waitForAgentReady({ hostPort: port }, {
            protocol: 'tcp',
            timeoutMs: 2000,
        });
        assert.equal(ready, true);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('waitForAgentReady resolves false within the timeout for a closed port (tcp)', async () => {
    const port = await findFreePort();
    const startedAt = Date.now();
    const ready = await waitForAgentReady({ hostPort: port }, {
        protocol: 'tcp',
        timeoutMs: 600,
        intervalMs: 100,
        probeTimeoutMs: 100,
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(ready, false);
    // Must give up around the timeout, not hang indefinitely.
    assert.ok(elapsedMs < 4000, `expected to bail out fast, took ${elapsedMs}ms`);
});
