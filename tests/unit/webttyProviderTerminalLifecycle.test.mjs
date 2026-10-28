import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderTerminalChannel } from '../../cli/server/webtty/providerTerminalChannel.mjs';
import { ProviderTerminalClient } from '../../cli/server/webtty/providerTerminalClient.mjs';
import {
    harness, connect, launch, startRotation, finishRotation, flush, fields, ManualClock,
    ScriptedTerminalTransport, OWNER, GENERATION, PTY, OTHER, OPERATION, SECRET, NONCE,
} from './helpers/providerTerminalTransport.mjs';

function cleaned(h) {
    assert.equal(h.clock.timers.size, 0);
    for (const transport of h.transports) {
        assert.equal(transport.closed, 1);
        assert.equal(transport.eventNames().length, 0);
    }
}

test('send queue releases exactly once after timeout, late callback, throw and shutdown', async () => {
    const clock = new ManualClock();
    const transport = new ScriptedTerminalTransport();
    const channel = new ProviderTerminalChannel(transport, {
        timers: clock, limits: { handshakeMs: 100, sendMs: 10, queueBytes: 4 },
        checkLease() {}, onFrame() {}, onClose() {},
    });
    transport.autoCallback = false;
    const one = channel.send(Buffer.alloc(4), true);
    const rejected = assert.rejects(one, /send/);
    assert.equal(channel.queuedBytes, 4);
    await assert.rejects(channel.send(Buffer.alloc(1), true), /backpressure/);
    await clock.advance(10);
    await rejected;
    assert.equal(channel.queuedBytes, 0);
    transport.callbacks[0](null);
    transport.callbacks[0](new Error('synthetic secret from transport'));
    await flush();
    assert.equal(channel.queuedBytes, 0);
    transport.autoCallback = true;
    await channel.send(Buffer.alloc(4), true);
    assert.equal(channel.queuedBytes, 0);
    transport.send = () => { throw new Error('synthetic secret from transport'); };
    await assert.rejects(channel.send(Buffer.alloc(4), true), { message: 'Provider terminal: send' });
    assert.equal(channel.queuedBytes, 0);
    channel.close();
    assert.equal(clock.timers.size, 0);
    assert.equal(transport.eventNames().length, 0);
});

test('shutdown during pending open closes a late transport without publishing or retaining timers', async () => {
    let resolve;
    const h = harness({ open: () => new Promise((done) => { resolve = done; }) });
    const opening = h.client.connect({ lease: h.lease });
    const rejected = assert.rejects(opening, /connect_failed/);
    await flush();
    await assert.rejects(h.client.connect({ lease: h.lease }), /busy/);
    await h.client.shutdown();
    await rejected;
    assert.equal(h.openings[0].signal.aborted, true);
    resolve();
    await flush();
    assert.equal(h.transports[0].sent.length, 0);
    cleaned(h);
});

test('handshake timeout, wrong first frame, invalid secret and malformed ready frames all clean resources', async () => {
    for (const scenario of ['timeout', 'wrong-first', 'bad-secret', 'wrong-direction', 'extra-key']) {
        const h = harness();
        const opening = h.client.connect({ lease: h.lease });
        const rejected = assert.rejects(opening, { message: 'Provider terminal: connect_failed' });
        await flush();
        const transport = h.transports[0];
        if (scenario === 'timeout') await h.clock.advance(200);
        else if (scenario === 'wrong-first') transport.peer('heartbeat-ok', { leaseExpiresAt: 12 });
        else if (scenario === 'wrong-direction') transport.peer('hello');
        else if (scenario === 'extra-key') transport.peer('challenge', { nonce: NONCE, password: SECRET });
        else {
            transport.peer('challenge', { nonce: NONCE });
            await flush();
            transport.peer('hello-ok', { ownershipSessionId: OWNER, workerGeneration: GENERATION,
                leaseExpiresAt: 12, secret: 'not-a-secret' });
        }
        await rejected;
        await h.client.shutdown();
        cleaned(h);
        assert.equal(JSON.stringify(h.diagnostics).includes(SECRET), false);
    }
});

test('failed reattachment never sends hello and leaves old connection until explicitly replaced', async () => {
    const h = harness();
    const old = await connect(h);
    await launch(h, old);
    const rotation = await startRotation(h);
    const rejected = assert.rejects(rotation.promise, /connect_failed/);
    rotation.transport.peer('hello-ok', { ownershipSessionId: OTHER, workerGeneration: OTHER,
        leaseExpiresAt: 13, secret: SECRET });
    await rejected;
    assert.equal(old.closed, 0);
    assert.equal(rotation.transport.controls('hello').length, 0);
    const next = await startRotation(h);
    await finishRotation(next, [{ ptySessionId: PTY, inputNext: '1', outputLast: '0' }]);
    assert.equal(next.transport.controls('hello').length, 0);
    await h.client.shutdown();
    cleaned(h);
});

test('shutdown races rotation and launch; late responses cannot resurrect state', async () => {
    const h = harness();
    const old = await connect(h);
    await launch(h, old);
    const pendingLaunch = h.client.launch(fields({ operationId: OTHER }), { lease: h.lease });
    const launchRejected = assert.rejects(pendingLaunch, /launch_uncertain/);
    const rotation = await startRotation(h);
    const rotationRejected = assert.rejects(rotation.promise, /connect_failed/);
    await assert.rejects(h.client.rotate({ lease: h.lease }), /busy/);
    const late = rotation.transport.listeners('message')[0];
    old.autoCallback = false;
    const closed = h.client.shutdown();
    await h.clock.advance(50);
    await Promise.all([closed, launchRejected, rotationRejected]);
    late(JSON.stringify({ v: 1, type: 'reattach-ok', leaseExpiresAt: 12, ptys: [] }), false);
    for (const callback of old.callbacks) callback(null);
    await flush();
    assert.equal(old.controls('close').length, 1);
    await assert.rejects(h.client.connect({ lease: h.lease }), /closed/);
    cleaned(h);
});

test('pre-dispatch matching launch reply cannot adopt a PTY while evidence is unresolved', async () => {
    let resolve;
    const h = harness({ evidence: () => new Promise((done) => { resolve = done; }) });
    const transport = await connect(h);
    const pending = h.client.launch(fields(), { lease: h.lease });
    await flush();
    transport.peer('launched', { operationId: OPERATION, ptySessionId: OTHER });
    await assert.rejects(h.client.attach(OTHER, { lease: h.lease }), /unknown_pty/);
    resolve('synthetic-evidence');
    await flush();
    transport.peer('launched', { operationId: OPERATION, ptySessionId: PTY });
    assert.equal(await pending, PTY);
    await h.client.shutdown();
    cleaned(h);
});

test('timed-out evidence cannot send a late launch or leak callback exception text', async () => {
    let resolve;
    const h = harness({ evidence: () => new Promise((done) => { resolve = done; }) });
    const transport = await connect(h);
    const rejected = assert.rejects(h.client.launch(fields(), { lease: h.lease }), /launch_uncertain/);
    await h.clock.advance(100);
    await rejected;
    resolve('synthetic-private-evidence');
    await flush();
    assert.equal(transport.controls('launch').length, 0);
    await h.client.shutdown();
    cleaned(h);
});

test('queue refusal preserves unsent sequence for explicit attach replay without skipping input', async () => {
    const h = harness({ limits: { queueBytes: 3200, inputBytes: 10000 } });
    const transport = await connect(h);
    await launch(h, transport);
    await h.client.attach(PTY, { lease: h.lease });
    transport.autoCallback = false;
    const first = h.client.input(PTY, Buffer.alloc(3000, 1), { lease: h.lease });
    await assert.rejects(h.client.input(PTY, Buffer.alloc(3000, 2), { lease: h.lease }), /backpressure/);
    await assert.rejects(h.client.input(PTY, Buffer.from('third'), { lease: h.lease }), /input_requires_reattach/);
    transport.callbacks[0](null);
    await first;
    transport.autoCallback = true;
    await h.client.attach(PTY, { lease: h.lease });
    assert.deepEqual(transport.sent.filter((frame) => frame.binary).map((frame) => frame.data.readBigUInt64BE(18)),
        [1n, 1n, 2n]);
    transport.peer('ack', { ptySessionId: PTY, sequence: '2' });
    assert.equal(await h.client.input(PTY, Buffer.from('third'), { lease: h.lease }), 3n);
    await h.client.shutdown();
    cleaned(h);
});

test('impossible input acknowledgement or regressed inventory fences channel without claiming termination', async () => {
    const h = harness();
    const old = await connect(h);
    await launch(h, old);
    const ended = [];
    h.client.on('ended', (frame) => ended.push(frame));
    old.peer('ack', { ptySessionId: PTY, sequence: '1' });
    assert.equal(old.closed, 1);
    const rotation = await startRotation(h);
    const rejected = assert.rejects(rotation.promise, /connect_failed/);
    rotation.transport.peer('reattach-ok', { leaseExpiresAt: 12,
        ptys: [{ ptySessionId: PTY, inputNext: '2', outputLast: '0' }] });
    await rejected;
    assert.equal(ended.length, 0);
    await h.client.shutdown();
    cleaned(h);
});

test('local heartbeat/liveness timeout reports no remote termination and disposes retained ownership', async () => {
    const h = harness();
    const transport = await connect(h);
    await launch(h, transport);
    const ended = [];
    h.client.on('ended', (frame) => ended.push(frame));
    await h.clock.advance(3000);
    assert.equal(ended.length, 0);
    assert.equal(transport.closed, 1);
    await assert.rejects(h.client.rotate({ lease: h.lease }), /closed/);
    await h.client.shutdown();
    cleaned(h);
});

test('concurrent attaches cannot clear or overwrite another attachment attempt', async () => {
    const h = harness();
    const transport = await connect(h);
    await launch(h, transport);
    transport.autoCallback = false;
    const attaching = h.client.attach(PTY, { lease: h.lease });
    await assert.rejects(h.client.attach(PTY, { lease: h.lease, afterOutputSequence: 5n }), /busy/);
    transport.callbacks[0](null);
    await attaching;
    transport.autoCallback = true;
    const output = [];
    h.client.on('output', (frame) => output.push(frame.sequence));
    transport.output(PTY, 1n);
    assert.deepEqual(output, [1n]);
    await h.client.shutdown();
    cleaned(h);
});

test('refused close retries after queue drains; in-flight and successful closes stay idempotent', async () => {
    const h = harness({ limits: { queueBytes: 3200, inputBytes: 10000 } });
    const transport = await connect(h);
    await launch(h, transport);
    await h.client.attach(PTY, { lease: h.lease });
    transport.autoCallback = false;
    const input = h.client.input(PTY, Buffer.alloc(3174), { lease: h.lease });
    await assert.rejects(h.client.close(PTY, { lease: h.lease }), /backpressure/);
    assert.equal(transport.controls('close').length, 0);
    transport.callbacks[0](null);
    await input;
    h.lease.current = false;
    assert.throws(() => h.client.close(PTY, { lease: h.lease }), /stale_lease/);
    h.lease.current = true;
    const retry = h.client.close(PTY, { lease: h.lease });
    const duplicate = h.client.close(PTY, { lease: h.lease });
    assert.equal(retry, duplicate);
    assert.equal(transport.controls('close').length, 1);
    transport.callbacks[1](null);
    await retry;
    assert.equal(h.client.close(PTY, { lease: h.lease }), retry);
    transport.autoCallback = true;
    await h.client.shutdown();
    cleaned(h);
});

test('uncertain close retries after rotation without claiming termination', async () => {
    const h = harness();
    const old = await connect(h);
    await launch(h, old);
    old.autoCallback = false;
    const rejected = assert.rejects(h.client.close(PTY, { lease: h.lease }), /send/);
    await h.clock.advance(50);
    await rejected;
    const rotation = await startRotation(h);
    await finishRotation(rotation, [{ ptySessionId: PTY, inputNext: '1', outputLast: '0' }]);
    await h.client.close(PTY, { lease: h.lease });
    assert.equal(rotation.transport.controls('close').length, 1);
    old.callbacks[0](null);
    await h.client.shutdown();
    cleaned(h);
});

test('buffered supersession during activation rejects rotation instead of reporting connected', async () => {
    const h = harness();
    const old = await connect(h);
    const pending = h.client.rotate({ lease: h.lease });
    const rejected = assert.rejects(pending, /connect_failed/);
    await flush();
    const transport = h.transports.at(-1);
    transport.autoCallback = false;
    transport.peer('challenge', { nonce: NONCE });
    await flush();
    transport.peer('reattach-ok', { leaseExpiresAt: 12, ptys: [] });
    transport.peer('superseded-connection');
    transport.callbacks[0](null);
    await rejected;
    assert.equal(old.closed, 1);
    assert.equal(transport.closed, 1);
    await h.client.shutdown();
    cleaned(h);
});

test('consumer shutdown during buffered ended activation rejects rotation and leaves no timer', async () => {
    const h = harness();
    const old = await connect(h);
    await launch(h, old);
    let shuttingDown;
    h.client.on('ended', () => { shuttingDown = h.client.shutdown(); });
    const rotation = await startRotation(h);
    const rejected = assert.rejects(rotation.promise, /connect_failed/);
    rotation.transport.peer('reattach-ok', { leaseExpiresAt: 12,
        ptys: [{ ptySessionId: PTY, inputNext: '1', outputLast: '0' }] });
    rotation.transport.peer('ended', { ptySessionId: PTY, cause: 'exit' });
    await rejected;
    await shuttingDown;
    cleaned(h);
});

test('constructor requires an explicit complete set of positive finite resource limits', () => {
    const options = {
        provider: 'provider', path: '/terminal', openTransport() {}, routerServiceTokenService: { mint() {} },
        mintLaunchEvidence() {}, isLeaseCurrent() {},
    };
    const limits = { handshakeMs: 200, sendMs: 50, operationMs: 100, heartbeatMs: 1000, leaseMs: 3000,
        operations: 4, ptys: 4, queueBytes: 4096, inputBytes: 4096 };
    assert.doesNotThrow(() => new ProviderTerminalClient({ ...options, limits }));
    for (const incomplete of [undefined, null, {}, { sendMs: 50 }]) {
        assert.throws(() => new ProviderTerminalClient({ ...options, limits: incomplete }), /configuration/);
    }
    for (const name of Object.keys(limits)) {
        const missing = { ...limits };
        delete missing[name];
        assert.throws(() => new ProviderTerminalClient({ ...options, limits: missing }), /configuration/);
        for (const invalid of [0, -1, 1.5, Infinity, NaN, '100', 0x80000000]) {
            assert.throws(() => new ProviderTerminalClient({ ...options, limits: { ...limits, [name]: invalid } }),
                /configuration/);
        }
    }
    assert.throws(() => new ProviderTerminalClient({ ...options, limits: { ...limits, extra: 1 } }), /configuration/);
});
