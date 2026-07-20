import test from 'node:test';
import assert from 'node:assert/strict';

import { recordProxyOutcome } from '../../cli/server/proxy/recordProxyOutcome.js';

test('proxy audit events are generation-aware, bounded, and credential-free', () => {
    let emitted;
    const event = recordProxyOutcome({
        plan: {
            auditId: 'audit-1',
            generationDigest: 'generation-1',
            listenerClass: 'public',
            surfaceKind: 'agent-port-convention',
            owner: { effectiveInstanceId: 'instance-1' },
            routeKey: 'alpha',
            port: 7000,
            method: 'POST',
            transport: 'http',
            access: { access: 'authenticated' },
        },
        outcome: 'failure',
        error: Object.assign(new Error('Bearer secret must never appear'), { code: 'TARGET_FAILURE' }),
        status: 502,
        requestBytes: 12,
        responseBytes: 3,
        leaseOutcome: 'committed',
        relayOutcome: 'ready',
        upstreamOutcome: 'failure',
        sink: value => { emitted = value; },
    });
    assert.equal(emitted, event);
    assert.equal(Object.isFrozen(event), true);
    assert.equal(event.ownerInstanceId, 'instance-1');
    assert.equal(event.status, 502);
    assert.equal(event.requestBytes, 12);
    assert.equal(event.responseBytes, 3);
    assert.equal(event.errorCode, 'TARGET_FAILURE');
    assert.doesNotMatch(JSON.stringify(event), /Bearer|secret|127\.0\.0\.1|Authorization/i);
});
