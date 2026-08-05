import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { probeRouterHealthSocket, waitForRouterReady } from '../../cli/commands/workspaceUtil.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const routingServerPath = path.join(repoRoot, 'cli/server/RoutingServer.js');

function connectedSocket(attempts) {
    return (options) => {
        attempts.push(options);
        const socket = new EventEmitter();
        socket.destroy = () => {};
        socket.setTimeout = () => {};
        queueMicrotask(() => socket.emit('connect'));
        return socket;
    };
}

test('router readiness requires both loopback TCP and the exact workspace health socket', async () => {
    const attempts = [];
    const healthAttempts = [];
    await waitForRouterReady(8080, null, 500, {
        createConnection: connectedSocket(attempts),
        healthSocketPath: '/exact/workspace/router-health.sock',
        async probeHealthSocket(socketPath) {
            healthAttempts.push(socketPath);
            return true;
        },
    });
    assert.deepEqual(attempts, [{ host: '127.0.0.1', port: 8080 }]);
    assert.deepEqual(healthAttempts, ['/exact/workspace/router-health.sock']);

    await assert.rejects(
        () => waitForRouterReady(8080, null, 10, {
            createConnection: connectedSocket([]),
            healthSocketPath: '/foreign/workspace/router-health.sock',
            probeHealthSocket: async () => false,
        }),
        (error) => {
            assert.equal(error.code, 'PLOINKY_ROUTER_WORKSPACE_MISMATCH');
            assert.match(error.message, /occupied without the exact workspace Router health socket/);
            return true;
        },
    );
    await assert.rejects(
        () => waitForRouterReady(42817, null, 1),
        /must be exactly 8080/,
    );
});

test('exact Router health probe requires an owned mode-0600 socket and canonical response', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-health-'));
    const socketPath = path.join(dir, 'router-health.sock');
    const server = http.createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'healthy', pid: process.pid }));
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
    });
    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    fs.chmodSync(socketPath, 0o666);
    assert.equal(await probeRouterHealthSocket(socketPath), false);
    fs.chmodSync(socketPath, 0o600);
    assert.equal(await probeRouterHealthSocket(socketPath), true);
});

test('Router shutdown never infers process ownership from a shared TCP port', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'cli/commands/sessionControl.js'), 'utf8');
    assert.doesNotMatch(source, /\blsof\b|\bss -ltnp\b|port_scan|findPids/);
    assert.match(source, /path\.join\(RUNNING_DIR, 'router\.pid'\)/);
});

test('RoutingServer fixes public 8080 and delegates private 8081 to exact interface listeners', () => {
    const source = fs.readFileSync(routingServerPath, 'utf8');
    assert.match(source, /server\.listen\(port, '0\.0\.0\.0'/);
    assert.doesNotMatch(source, /router\.sock|routerSocketServer|net\.createServer/);

    assert.match(source, /const port = 8080/);
    assert.match(source, /createPrivateListenerSet\(\{/);
    assert.match(source, /port: privatePort/);
    assert.match(source, /privateListenerSet\.start\(\)/);
    const classifierStart = source.indexOf('await interfaceClassifier.start()');
    const privateStart = source.indexOf('await privateListenerSet.start()');
    assert.ok(
        classifierStart >= 0 && classifierStart < privateStart,
        'interface classification must be primed before private listener readiness',
    );
    assert.doesNotMatch(
        fs.readFileSync(path.join(repoRoot, 'cli/server/listenerInterfaceClassifier.js'), 'utf8')
            .match(/function classify[\s\S]*?\n    }/)?.[0] || '',
        /\brefresh\(/,
    );
    assert.doesNotMatch(source, /privateServer\.listen\(/);
    assert.doesNotMatch(source, /privateServer\.prependListener\('connection'/);
    const authGate = source.indexOf('const authResult = await ensureAuthenticated(req, res, parsedUrl, { routePlan });');
    const tcpHealth = source.indexOf("if (pathname === '/health')", authGate);
    assert.ok(authGate >= 0 && tcpHealth > authGate, 'TCP health must dispatch only after authentication');
    assert.match(source.slice(tcpHealth, tcpHealth + 800), /requireAdminControlRequest\(req, res\)/);
    assert.match(source, /const task = await readAuthenticatedAgentTask\(\{/);
    assert.match(source, /sendJsonResponse\(res, 200, \{ task \}, \{ 'Cache-Control': 'no-store' \}\)/);

    for (const port of ['', '+8080', '8080x', '0', '65536', '8081']) {
        const env = { ...process.env };
        env.PORT = port;
        const result = spawnSync(process.execPath, [routingServerPath], {
            cwd: repoRoot,
            env,
            encoding: 'utf8',
            timeout: 5000,
        });
        assert.notEqual(result.status, 0, `PORT=${JSON.stringify(port)} unexpectedly started`);
        assert.match(`${result.stderr}\n${result.stdout}`, /managed Router requires PORT to be exactly 8080/);
    }
});
