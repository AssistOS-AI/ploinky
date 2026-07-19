import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { waitForRouterReady } from '../../cli/services/workspaceUtil.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const routingServerPath = path.join(repoRoot, 'cli/server/RoutingServer.js');

test('router readiness is TCP-only against 127.0.0.1', async () => {
    const attempts = [];
    await waitForRouterReady(8080, null, 500, {
        createConnection(options) {
            attempts.push(options);
            const socket = new EventEmitter();
            socket.destroy = () => {};
            socket.setTimeout = () => {};
            queueMicrotask(() => socket.emit('connect'));
            return socket;
        },
    });
    assert.deepEqual(attempts, [{ host: '127.0.0.1', port: 8080 }]);
    await assert.rejects(
        () => waitForRouterReady(42817, null, 1),
        /must be exactly 8080/,
    );
});

test('RoutingServer fixes public 8080 and delegates private 8081 to exact interface listeners', () => {
    const source = fs.readFileSync(routingServerPath, 'utf8');
    assert.match(source, /server\.listen\(port, '0\.0\.0\.0'/);
    assert.doesNotMatch(source, /router\.sock|routerSocketServer|net\.createServer/);

    assert.match(source, /const port = 8080/);
    assert.match(source, /createPrivateListenerSet\(\{/);
    assert.match(source, /port: privatePort/);
    assert.match(source, /privateListenerSet\.start\(\)/);
    assert.doesNotMatch(source, /privateServer\.listen\(/);
    assert.doesNotMatch(source, /privateServer\.prependListener\('connection'/);
    const authGate = source.indexOf('const authResult = await ensureAuthenticated(req, res, parsedUrl, { routePlan });');
    const tcpHealth = source.indexOf("if (pathname === '/health')", authGate);
    assert.ok(authGate >= 0 && tcpHealth > authGate, 'TCP health must dispatch only after authentication');
    assert.match(source.slice(tcpHealth, tcpHealth + 800), /requireAdminControlRequest\(req, res\)/);

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
        assert.match(`${result.stderr}\n${result.stdout}`, /runtime contract v5 requires PORT to be exactly 8080/);
    }
});
