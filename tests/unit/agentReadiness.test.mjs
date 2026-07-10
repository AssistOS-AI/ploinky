import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { waitForAgentReady } from '../../cli/server/utils/agentReadiness.js';
import {
    buildBlockingReadinessEntryFromNode,
    waitForReadinessEntries,
} from '../../cli/services/workspaceUtil.js';

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

test('blocking startup readiness allows protocol none without a host port', () => {
    const entry = buildBlockingReadinessEntryFromNode({
        id: 'worker',
        shortAgentName: 'worker',
        isStatic: false,
        manifest: {
            readiness: { protocol: 'none' },
        },
    }, {}, 'explorer');

    assert.equal(entry.protocol, 'none');
    assert.equal(entry.route?.hostPort, undefined);
});

test('blocking startup readiness still requires a host port for tcp agents', () => {
    assert.throws(() => buildBlockingReadinessEntryFromNode({
        id: 'api',
        shortAgentName: 'api',
        isStatic: false,
        manifest: {
            readiness: { protocol: 'tcp' },
        },
    }, {}, 'explorer'), /did not expose a host port/);
});

test('start-only script readiness is blocking without a host port and carries the route container', () => {
    const entry = buildBlockingReadinessEntryFromNode({
        id: 'database',
        shortAgentName: 'database',
        isStatic: false,
        manifest: {
            start: 'postgres',
            health: {
                readiness: {
                    script: 'healthcheck.sh',
                    interval: 2,
                    timeout: 3,
                    failureThreshold: 4,
                },
            },
        },
    }, { container: 'database-container', hostPort: 0 }, 'explorer');

    assert.equal(entry.protocol, 'script');
    assert.equal(entry.route.container, 'database-container');
    assert.equal(entry.route.hostPort, 0);
    assert.equal(entry.scriptProbe.script, 'healthcheck.sh');
    assert.equal(entry.scriptProbe.failureThreshold, 4);
});

test('explicit MCP readiness takes precedence over a declared health script', () => {
    const entry = buildBlockingReadinessEntryFromNode({
        id: 'runner',
        shortAgentName: 'runner',
        isStatic: false,
        manifest: {
            agent: 'sh /Agent/server/AgentServer.sh',
            readiness: { protocol: 'mcp' },
            health: { readiness: { script: 'healthcheck.sh' } },
        },
    }, { container: 'runner-container', hostPort: 31234 }, 'explorer');

    assert.equal(entry.protocol, 'mcp');
    assert.equal(entry.scriptProbe, undefined);
});

test('start-only additionalServerPort readiness remains TCP and uses its resolved private route', () => {
    const entry = buildBlockingReadinessEntryFromNode({
        id: 'private-api',
        shortAgentName: 'private-api',
        isStatic: false,
        manifest: { start: 'node server.mjs' },
    }, {
        container: 'private-api-container',
        hostPort: 42345,
        additionalServerPort: {
            url: 'http://127.0.0.1:42345',
            containerUrl: 'http://127.0.0.1:9000',
            mode: 'host',
        },
    }, 'explorer');

    assert.equal(entry.protocol, 'tcp');
    assert.equal(entry.route.hostPort, 42345);
});

test('start-only readiness without a port, script, or none policy fails with a manifest contract error', () => {
    assert.throws(() => buildBlockingReadinessEntryFromNode({
        id: 'broken-service',
        shortAgentName: 'broken-service',
        isStatic: false,
        manifest: { start: 'node service.mjs' },
    }, { container: 'broken-service-container', hostPort: 0 }, 'explorer'), /start-only.*health\.readiness\.script.*additionalServerPort.*readiness\.protocol.*none/i);
});

test('script readiness success is dispatched against the route container', async () => {
    const calls = [];
    const entry = buildBlockingReadinessEntryFromNode({
        id: 'service',
        shortAgentName: 'service',
        isStatic: false,
        manifest: {
            start: 'serve',
            health: { readiness: { script: 'ready.sh' } },
        },
    }, { container: 'service-container', hostPort: 0 }, 'explorer');

    await waitForReadinessEntries([entry], {
        runContainerScriptReadinessImpl(agentName, containerName, probe) {
            calls.push({ agentName, containerName, probe });
            return { status: 'success', detail: 'ready' };
        },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].agentName, 'service');
    assert.equal(calls[0].containerName, 'service-container');
    assert.equal(calls[0].probe.script, 'ready.sh');
});

test('script readiness failure blocks the caller', async () => {
    const entry = buildBlockingReadinessEntryFromNode({
        id: 'service',
        shortAgentName: 'service',
        isStatic: false,
        manifest: {
            start: 'serve',
            health: { readiness: { script: 'ready.sh', failureThreshold: 1 } },
        },
    }, { container: 'service-container', hostPort: 0 }, 'explorer');

    await assert.rejects(
        waitForReadinessEntries([entry], {
            runContainerScriptReadinessImpl() {
                return { status: 'failed', reason: 'exit 7', detail: 'not ready' };
            },
        }),
        /service.*ready\.sh.*exit 7.*not ready/i,
    );
});
