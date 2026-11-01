import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderTerminalClient } from '../../cli/server/webtty/providerTerminalClient.mjs';
import { openProviderTerminalTransport } from '../../cli/server/webtty/providerTerminalTransport.mjs';
import { ManualClock, OWNER, GENERATION, SECRET, nonceFor } from './helpers/providerTerminalTransport.mjs';
import { fakeRelayManager, providerPlan, readClientFrame, serverFrame, upgradeAnswer } from './helpers/providerTerminalRelay.mjs';

test('coalesced upgrade HEAD challenge survives async client open and reattachment', async () => {
    const clock = new ManualClock();
    const lease = { id: 'generation-1', isCurrent: () => true };
    const controls = [];
    let connections = 0;
    const relay = fakeRelayManager((request, stream) => {
        const nonce = nonceFor(connections++);
        stream.write = (bytes) => {
            const frame = readClientFrame(bytes);
            assert.equal(frame.masked, true);
            if (frame.opcode === 0x8) return true;
            const control = JSON.parse(frame.payload);
            controls.push(control);
            const reply = control.type === 'hello'
                ? { v: 1, type: 'hello-ok', ownershipSessionId: OWNER, workerGeneration: GENERATION,
                    leaseExpiresAt: 12, secret: SECRET }
                : { v: 1, type: 'reattach-ok', leaseExpiresAt: 12, ptys: [] };
            queueMicrotask(() => stream.push(serverFrame(0x1, JSON.stringify(reply))));
            return true;
        };
        // These bytes enter the real HTTP parser together, making challenge
        // part of the upgrade HEAD before the client's async open resolves.
        return Buffer.concat([upgradeAnswer(request.headers['sec-websocket-key']),
            serverFrame(0x1, JSON.stringify({ v: 1, type: 'challenge', nonce }))]);
    });
    const client = new ProviderTerminalClient({
        provider: 'agent:fixture/provider', path: '/fixture/terminal-control',
        openTransport: async ({ signal, headers }) => {
            const transport = await openProviderTerminalTransport({
                plan: providerPlan({ lease }), lease, relayManager: relay,
                authInfo: headers['x-ploinky-auth-info'], signal,
            });
            await Promise.resolve();
            return transport;
        },
        routerServiceTokenService: { mint: () => 'fixture-token' }, mintLaunchEvidence: () => 'fixture-evidence',
        isLeaseCurrent: (value) => value === lease,
        now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
        limits: { handshakeMs: 200, sendMs: 50, operationMs: 100, heartbeatMs: 1000, leaseMs: 3000,
            operations: 4, ptys: 4, queueBytes: 4096, inputBytes: 4096 },
    });
    try {
        for (const method of ['connect', 'rotate']) {
            const result = client[method]({ lease }).then((value) => value, (error) => error);
            await new Promise((resolve) => setImmediate(resolve));
            await clock.advance(200);
            assert.deepEqual(await result, { connected: true }, method);
        }
        assert.deepEqual(controls.map((control) => control.type), ['hello', 'reattach']);
        assert.equal(connections, 2);
    } finally {
        await client.shutdown();
    }
    assert.equal(clock.timers.size, 0);
    assert.equal(relay.checkouts.every((checkout) => checkout.closed >= 1), true);
});

test('failed startup rejects promptly, releases its relay and sends no authentication or terminal data', async () => {
    for (const cause of ['early-close', 'early-error', 'head-close', 'wrong-first', 'challenge-then-data', 'oversize']) {
        const clock = new ManualClock();
        const lease = { id: 'generation-1', isCurrent: () => true };
        const controls = [];
        let transport;
        const relay = fakeRelayManager((request, stream) => {
            stream.write = (bytes) => { controls.push(readClientFrame(bytes).opcode); return true; };
            const challenge = serverFrame(0x1, JSON.stringify({ v: 1, type: 'challenge', nonce: nonceFor(0) }));
            const head = cause === 'head-close' ? serverFrame(0x8)
                : cause === 'wrong-first' ? serverFrame(0x2, Buffer.from('not authenticated'))
                    : cause === 'challenge-then-data' ? Buffer.concat([challenge, serverFrame(0x2, Buffer.from('early'))])
                        : cause === 'oversize' ? Buffer.alloc(65_573) : challenge;
            return Buffer.concat([upgradeAnswer(request.headers['sec-websocket-key']), head]);
        });
        const client = new ProviderTerminalClient({
            provider: 'agent:fixture/provider', path: '/fixture/terminal-control',
            openTransport: async ({ signal, headers }) => {
                transport = await openProviderTerminalTransport({
                    plan: providerPlan({ lease }), lease, relayManager: relay,
                    authInfo: headers['x-ploinky-auth-info'], signal,
                });
                if (cause === 'early-close') transport.socket.emit('end');
                if (cause === 'early-error') transport.socket.emit('error', new Error('fixture failure'));
                return transport;
            },
            routerServiceTokenService: { mint: () => 'fixture-token' }, mintLaunchEvidence: () => 'fixture-evidence',
            isLeaseCurrent: (value) => value === lease,
            now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
            limits: { handshakeMs: 200, sendMs: 50, operationMs: 100, heartbeatMs: 1000, leaseMs: 3000,
                operations: 4, ptys: 4, queueBytes: 4096, inputBytes: 4096 },
        });
        const result = client.connect({ lease }).then(() => 'connected', (error) => error.code);
        try {
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(await Promise.race([result, Promise.resolve('pending')]),
                'PROVIDER_TERMINAL_CONNECT_FAILED', cause);
        } finally {
            await client.shutdown();
        }
        assert.deepEqual(controls.filter((opcode) => opcode !== 0x8), [], cause);
        assert.equal(clock.timers.size, 0, cause);
        assert.equal(transport.buffer.length, 0, cause);
        assert.equal(transport.closed, true, cause);
        assert.equal(transport.listenerCount('message'), 0, cause);
        assert.equal(transport.listenerCount('error'), 0, cause);
        assert.equal(transport.listenerCount('close'), 0, cause);
        assert.equal(relay.checkouts.every((checkout) => checkout.closed >= 1), true, cause);
    }
});
