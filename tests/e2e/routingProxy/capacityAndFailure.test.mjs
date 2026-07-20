import test from 'node:test';
import assert from 'node:assert/strict';

import { RuntimeRelayManager } from '../../../cli/server/runtimeRelay/RuntimeRelayManager.js';

test('relay capacity is bounded globally and per agent and recovers after release', () => {
    const manager = new RuntimeRelayManager({
        minter: {},
        limits: { concurrentStreamsPerAgent: 2, concurrentStreamsTotal: 3 },
    });
    const releaseA1 = manager._reserve('agent-a');
    const releaseA2 = manager._reserve('agent-a');
    assert.throws(() => manager._reserve('agent-a'), /concurrency limit/);
    const releaseB1 = manager._reserve('agent-b');
    assert.throws(() => manager._reserve('agent-c'), /concurrency limit/);
    releaseA1();
    const releaseC1 = manager._reserve('agent-c');
    releaseA2();
    releaseB1();
    releaseC1();
    assert.equal(manager.totalActive, 0);
    assert.equal(manager.agentActive.size, 0);
});

test('capacity release is idempotent after failure cleanup', () => {
    const manager = new RuntimeRelayManager({ minter: {}, limits: { concurrentStreamsPerAgent: 1, concurrentStreamsTotal: 1 } });
    const release = manager._reserve('agent-a');
    release();
    release();
    assert.equal(manager.totalActive, 0);
});

test('request generation limits apply without resetting active capacity counters', () => {
    const manager = new RuntimeRelayManager({
        minter: {},
        limits: { concurrentStreamsPerAgent: 8, concurrentStreamsTotal: 8 },
    });
    const release = manager._reserve('agent-a', {
        concurrentStreamsPerAgent: 2,
        concurrentStreamsTotal: 2,
    });
    assert.throws(() => manager._reserve('agent-b', {
        concurrentStreamsPerAgent: 1,
        concurrentStreamsTotal: 1,
    }), /concurrency limit/);
    release();
    assert.equal(manager.totalActive, 0);
});
