import test from 'node:test';
import assert from 'node:assert/strict';

import { createPrivateListener, PRIVATE_LISTENER_HOST } from '../../cli/server/privateListener.js';
import { proveContainerLoopbackBinding } from '../../cli/server/privateListenerBindings/containerLoopbackBinding.js';
import { CONTAINER_ID } from './routingProxyTestFixtures.mjs';

test('container proof uses only the runtime-owned host alias and immutable container id', async () => {
    let invocation;
    const proved = await proveContainerLoopbackBinding({
        runtime: 'podman',
        containerId: CONTAINER_ID,
        hostAlias: 'host.containers.internal',
        port: 8081,
        proofPath: '/proof',
        expectedBody: 'nonce',
        execFile: (...args) => {
            invocation = args.slice(0, -1);
            args.at(-1)(null, 'nonce');
        },
    });
    assert.equal(proved, true);
    assert.equal(invocation[0], 'podman');
    assert.deepEqual(invocation[1].slice(0, 3), ['exec', CONTAINER_ID, 'node']);
    assert.match(invocation[1].at(-1), /^http:\/\/host\.containers\.internal:8081\/proof$/);
    await assert.rejects(() => proveContainerLoopbackBinding({
        runtime: 'podman',
        containerId: CONTAINER_ID,
        hostAlias: 'attacker.example',
    }), /runtime-owned host alias/);
});
test('private listener binds loopback exactly and closes when proof fails', async () => {
    const server = await createPrivateListener({
        port: 0,
        handler: (_req, res) => res.end('ok'),
        proveBinding: async () => true,
    });
    assert.equal(server.address().address, PRIVATE_LISTENER_HOST);
    await new Promise(resolve => server.close(resolve));

    const boxServer = await createPrivateListener({
        host: '0.0.0.0',
        port: 0,
        handler: (_req, res) => res.end('ok'),
        proveBinding: async () => true,
    });
    assert.equal(boxServer.address().address, '0.0.0.0');
    await new Promise(resolve => boxServer.close(resolve));

    await assert.rejects(() => createPrivateListener({
        host: '192.0.2.1',
        port: 0,
        handler: (_req, res) => res.end('ok'),
    }), /bind host/);

    await assert.rejects(() => createPrivateListener({
        port: 0,
        handler: (_req, res) => res.end('ok'),
        proveBinding: async () => false,
    }), /proof failed/);
});
