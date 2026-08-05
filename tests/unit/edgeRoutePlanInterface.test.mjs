import test from 'node:test';
import assert from 'node:assert/strict';

import {
    commitRouteGeneration,
    commitRoutePlan,
    httpAccessForEdgeRoutePlan,
    isPrivateInterfaceAllowed,
} from '../../cli/server/edgeRoutePlan.js';

test('router-owned mutations commit the exact generation without requiring a proxy route', () => {
    let current = true;
    const routerOwnedPlan = {
        ok: false,
        code: 'ROUTE_NOT_FOUND',
        lease: {
            commit: () => current,
        },
    };

    assert.equal(commitRoutePlan(routerOwnedPlan), false);
    assert.equal(commitRouteGeneration(routerOwnedPlan), true);
    current = false;
    assert.equal(commitRouteGeneration(routerOwnedPlan), false);
});

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

test('edge route access keeps the original relay plan access contract', () => {
    const publicConventionAccess = Object.freeze({
        access: 'public',
        routeKey: 'liveKitServerAgent',
        source: 'manifest',
    });
    const authenticatedAgentAccess = Object.freeze({
        access: 'authenticated',
        routeKey: 'explorer',
        source: 'routeDefault',
    });

    assert.equal(httpAccessForEdgeRoutePlan({
        ok: true,
        kind: 'agent-port',
        access: publicConventionAccess,
    }), publicConventionAccess);
    assert.equal(httpAccessForEdgeRoutePlan({
        ok: true,
        kind: 'agent-root',
        decision: authenticatedAgentAccess,
    }), authenticatedAgentAccess);
    assert.equal(httpAccessForEdgeRoutePlan({ ok: false, access: publicConventionAccess }), null);
});
