process.env.PLOINKY_WATCHDOG_TEST_MODE = '1';
process.env.PLOINKY_WORKSPACE_ROOT = process.cwd();

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

const { buildHealthCheckRequestOptions } = await import('../../cli/server/Watchdog.js');
const { buildDashboardUrl } = await import('../../cli/commands/workspaceUtil.js');

function requestStatus(options) {
    return new Promise((resolve, reject) => {
        const request = http.get(options, (response) => {
            response.resume();
            response.once('end', () => resolve(response.statusCode));
        });
        request.once('error', reject);
    });
}

test('Watchdog connects internally while presenting the public authority', async (t) => {
    const expectedAuthority = '127.0.0.1:19090';
    const server = http.createServer((request, response) => {
        if (request.headers.host !== expectedAuthority) {
            response.writeHead(421).end();
            return;
        }
        response.writeHead(200).end('{"status":"healthy"}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address();

    const implicitStatus = await requestStatus(buildHealthCheckRequestOptions(port, {}));
    const publicStatus = await requestStatus(buildHealthCheckRequestOptions(port, {
        PLOINKY_PUBLIC_AUTHORITY: expectedAuthority,
    }));

    assert.equal(implicitStatus, 421);
    assert.equal(publicStatus, 200);
    assert.deepEqual(buildHealthCheckRequestOptions(port, {
        PLOINKY_PUBLIC_AUTHORITY: expectedAuthority,
    }), {
        hostname: '127.0.0.1',
        port,
        path: '/health',
        headers: { Host: expectedAuthority },
    });
});

test('Dashboard output uses only a nonempty public authority', () => {
    assert.equal(
        buildDashboardUrl(8080, {}),
        'http://127.0.0.1:8080/dashboard',
    );
    assert.equal(
        buildDashboardUrl(8080, { PLOINKY_PUBLIC_AUTHORITY: '127.0.0.1:19090' }),
        'http://127.0.0.1:19090/dashboard',
    );
});
