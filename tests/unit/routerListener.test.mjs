import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { waitForRouterReady } from '../../cli/services/workspaceUtil.js';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const routingServerPath = path.join(repoRoot, 'cli/server/RoutingServer.js');

test('router readiness is TCP-only against 127.0.0.1', async () => {
    const server = net.createServer((socket) => socket.destroy());
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    try {
        await waitForRouterReady(server.address().port, null, 500);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('RoutingServer requires a strict PORT and binds explicit IPv4 wildcard without Unix relay residue', () => {
    const source = fs.readFileSync(routingServerPath, 'utf8');
    assert.match(source, /server\.listen\(port, '0\.0\.0\.0'/);
    assert.doesNotMatch(source, /router\.sock|routerSocketServer|net\.createServer/);

    for (const port of [undefined, '', '+8080', '8080x', '0', '65536']) {
        const env = { ...process.env };
        if (port === undefined) delete env.PORT;
        else env.PORT = port;
        const result = spawnSync(process.execPath, [routingServerPath], {
            cwd: repoRoot,
            env,
            encoding: 'utf8',
            timeout: 5000,
        });
        assert.notEqual(result.status, 0, `PORT=${JSON.stringify(port)} unexpectedly started`);
        assert.match(`${result.stderr}\n${result.stdout}`, /RoutingServer PORT must be an integer number or exact unsigned decimal string/);
    }
});
