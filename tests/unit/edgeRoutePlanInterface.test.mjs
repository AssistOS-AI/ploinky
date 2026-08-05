import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
    commitRouteGeneration,
    commitRoutePlan,
    httpAccessForEdgeRoutePlan,
    isPrivateInterfaceAllowed,
    privateProviderTaskOperation,
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

test('bwrap root route commit verifies its immutable service owner after the generation lease', () => {
    const events = [];
    const ownerAttestation = Object.freeze({ runtimeKey: 'alpha-container' });
    const plan = {
        ok: true,
        ownerAttestation,
        lease: {
            commit() {
                events.push('lease');
                return true;
            },
        },
    };

    assert.equal(commitRoutePlan(plan, {
        assertServiceOwner(owner) {
            events.push('owner');
            assert.equal(owner, ownerAttestation);
        },
    }), true);
    assert.deepEqual(events, ['lease', 'owner']);
});

test('bwrap root route commit fails closed when its service owner no longer matches', () => {
    const mismatch = Object.assign(new Error('owner changed'), {
        code: 'PLOINKY_SANDBOX_OWNER_ATTESTATION_MISMATCH',
    });
    assert.throws(() => commitRoutePlan({
        ok: true,
        ownerAttestation: { runtimeKey: 'alpha-container' },
        lease: { commit: () => true },
    }, {
        assertServiceOwner() {
            throw mismatch;
        },
    }), (error) => error === mismatch);
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

test('provider task control surface is exact and private-operation only', () => {
    for (const operation of ['publish', 'heartbeat', 'log', 'report', 'terminal']) {
        assert.equal(
            privateProviderTaskOperation(`/api/edge/provider-tasks/${operation}`),
            `provider-tasks/${operation}`,
        );
    }
    assert.equal(privateProviderTaskOperation('/api/edge/provider-tasks/terminal/extra'), null);
    assert.equal(privateProviderTaskOperation('/api/edge/provider-tasks/cancel'), null);

    const source = fs.readFileSync(new URL('../../cli/server/edgeRoutePlan.js', import.meta.url), 'utf8');
    const inactiveFallback = source.slice(
        source.indexOf('const terminalCandidate ='),
        source.indexOf('const snapshot = lease.snapshot;'),
    );
    assert.match(inactiveFallback, /fallbackUrl\?\.pathname === '\/api\/edge\/provider-tasks\/terminal'/);
    assert.match(inactiveFallback, /String\(req\?\.method \|\| ''\)\.toUpperCase\(\) === 'POST'/);
    assert.doesNotMatch(inactiveFallback, /provider-tasks\/(?:publish|heartbeat|log|report)/);
});
