import test from 'node:test';
import assert from 'node:assert/strict';

import { isPrivateInterfaceAllowed } from '../../cli/server/edgeRoutePlan.js';

test('private listener class admits bridge-gateway requests without IP provenance', () => {
    const bridgeRequest = {
        ploinkyListenerClass: 'private',
        socket: {
            localAddress: '10.88.0.1',
            remoteAddress: '10.88.0.42',
        },
    };

    assert.equal(isPrivateInterfaceAllowed(bridgeRequest, 'private'), true);
    assert.equal(isPrivateInterfaceAllowed(bridgeRequest, 'public'), false);
    assert.equal(isPrivateInterfaceAllowed({ socket: bridgeRequest.socket }, 'private'), false);
});

test('loopback provenance cannot turn the public listener into a private listener', () => {
    const loopbackRequest = {
        socket: {
            localAddress: '127.0.0.1',
            remoteAddress: '127.0.0.1',
        },
    };

    assert.equal(isPrivateInterfaceAllowed(loopbackRequest, 'public'), false);
});
