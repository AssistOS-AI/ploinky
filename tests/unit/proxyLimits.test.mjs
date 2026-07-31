import test from 'node:test';
import assert from 'node:assert/strict';

import { compileProxyLimits, DEFAULT_PROXY_LIMITS } from '../../cli/server/proxy/limits.js';

test('proxy limits expose fixed bounded defaults', () => {
    const limits = compileProxyLimits();
    assert.deepEqual(limits, DEFAULT_PROXY_LIMITS);
    assert.equal(Object.isFrozen(limits), true);
    assert.equal(limits.connectTimeoutMs, 5_000);
    assert.equal(limits.headerTimeoutMs, 455_000);
    assert.equal(limits.webSocketHandshakeTimeoutMs, 15_000);
    assert.ok(limits.connectTimeoutMs < limits.headerTimeoutMs);
    assert.ok(limits.connectTimeoutMs < limits.webSocketHandshakeTimeoutMs);
});

test('proxy limits accept only coherent trusted overrides', () => {
    assert.equal(compileProxyLimits({ bufferedBodyBytes: 1024 }).bufferedBodyBytes, 1024);
    assert.throws(() => compileProxyLimits({ mystery: 1 }), /unknown limit/);
    assert.throws(() => compileProxyLimits({ connectTimeoutMs: 456_000 }), /connect timeout/);
    assert.throws(
        () => compileProxyLimits({ webSocketHandshakeTimeoutMs: 4_000 }),
        /WebSocket handshake timeout/
    );
    assert.throws(() => compileProxyLimits({ bufferedBodyBytes: 70 * 1024 * 1024 }), /bufferedBodyBytes/);
    assert.throws(() => compileProxyLimits({ webSocketFrameBytes: 9 * 1024 * 1024 }), /webSocketFrameBytes/);
    assert.throws(() => compileProxyLimits({ concurrentStreamsPerAgent: 300 }), /per-agent concurrency/);
    assert.throws(() => compileProxyLimits({ idleTimeoutMs: 0 }), /positive safe integer/);
});
