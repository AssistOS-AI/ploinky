import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';
import test from 'node:test';

import { BoundedClientWebSocket, openProviderTerminalTransport } from '../../cli/server/webtty/providerTerminalTransport.mjs';
import { PROVIDER_TERMINAL_LIMITS } from '../../cli/server/webtty/providerTerminalProtocol.mjs';
import {
    fakeRelayManager, providerPlan, readClientFrame, serverFrame, upgradeAnswer,
} from './helpers/providerTerminalRelay.mjs';

const flush = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };

function socketPair() {
    // Nothing written comes back: the peer is the test, not a loopback.
    const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
    const written = [];
    const originalWrite = socket.write.bind(socket);
    socket.write = (chunk, callback) => { written.push(Buffer.from(chunk)); return originalWrite(chunk, callback); };
    return { socket, written };
}

function feed(socket, bytes) {
    // The codec reads the socket's own 'data'; emitting it directly keeps the
    // test synchronous and independent of stream buffering.
    socket.emit('data', bytes);
}

test('text and binary frames arrive with their kind; split writes and back-to-back frames both parse', () => {
    const { socket } = socketPair();
    const ws = new BoundedClientWebSocket(socket);
    const seen = [];
    ws.on('message', (data, binary) => seen.push([Buffer.isBuffer(data) ? data.toString('hex') : data, binary]));
    const text = serverFrame(0x1, '{"v":1}');
    const bin = serverFrame(0x2, Buffer.from([1, 2, 3]));
    feed(socket, Buffer.concat([text.subarray(0, 3)]));
    feed(socket, Buffer.concat([text.subarray(3), bin]));
    assert.deepEqual(seen, [['{"v":1}', false], ['010203', true]]);
    assert.equal(ws.closed, false);
});

test('a ping is answered with a masked pong; a close frame ends the connection', () => {
    const { socket, written } = socketPair();
    const ws = new BoundedClientWebSocket(socket);
    let closed = 0;
    ws.on('close', () => { closed += 1; });
    feed(socket, serverFrame(0x9, 'hi'));
    const pong = readClientFrame(written[0]);
    assert.equal(pong.opcode, 0xa);
    assert.equal(pong.masked, true);
    assert.equal(pong.payload.toString(), 'hi');
    feed(socket, serverFrame(0x8, Buffer.from([0x03, 0xe8])));
    assert.equal(closed, 1);
    assert.equal(ws.closed, true);
    assert.equal(socket.destroyed, true);
});

test('every frame violation ends the connection before any payload is delivered', () => {
    const big = PROVIDER_TERMINAL_LIMITS.header + PROVIDER_TERMINAL_LIMITS.payload;
    const wideHeader = (length, opcode = 0x2) => {
        const header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(length), 2);
        return header;
    };
    const cases = {
        'masked server frame': serverFrame(0x1, 'x', { mask: true }),
        'fragmented message': serverFrame(0x1, 'x', { fin: false }),
        'continuation frame': serverFrame(0x0, 'x'),
        'extension bit': serverFrame(0x1, 'x', { rsv: 0x40 }),
        'unknown opcode': serverFrame(0x3, 'x'),
        'invalid UTF-8 text': serverFrame(0x1, Buffer.from([0xff, 0xfe])),
        'text over the control bound (header only)': Buffer.concat([wideHeader(PROVIDER_TERMINAL_LIMITS.json + 1, 0x1)]),
        'binary over the data bound (header only)': wideHeader(big + 1),
        'a length that cannot be represented': wideHeader(2 ** 40),
        'control frame over 125 bytes': serverFrame(0x9, Buffer.alloc(126)),
    };
    for (const [name, bytes] of Object.entries(cases)) {
        const { socket } = socketPair();
        const ws = new BoundedClientWebSocket(socket);
        const seen = [];
        let closed = 0;
        ws.on('message', (data) => seen.push(data));
        ws.on('close', () => { closed += 1; });
        feed(socket, bytes);
        assert.deepEqual(seen, [], name);
        assert.equal(closed, 1, name);
        assert.equal(ws.buffer.length, 0, `${name}: nothing stays buffered`);
    }
});

test('the largest allowed data and control frames are accepted', () => {
    const { socket } = socketPair();
    const ws = new BoundedClientWebSocket(socket);
    const sizes = [];
    ws.on('message', (data) => sizes.push(data.length));
    feed(socket, serverFrame(0x2, Buffer.alloc(PROVIDER_TERMINAL_LIMITS.header + PROVIDER_TERMINAL_LIMITS.payload)));
    feed(socket, serverFrame(0x1, 'a'.repeat(PROVIDER_TERMINAL_LIMITS.json)));
    assert.deepEqual(sizes, [26 + 64 * 1024, PROVIDER_TERMINAL_LIMITS.json]);
});

test('send writes masked frames of the right kind and reports the write result; a closed socket fails the callback', async () => {
    const { socket, written } = socketPair();
    const ws = new BoundedClientWebSocket(socket);
    const results = [];
    ws.send('{"v":1}', { binary: false }, (error) => results.push(error));
    ws.send(Buffer.from([9, 8]), { binary: true }, (error) => results.push(error));
    ws.send(Buffer.alloc(70_000, 5), { binary: true }, (error) => results.push(error));
    await new Promise((resolve) => setImmediate(resolve));
    const frames = written.map((bytes) => readClientFrame(bytes));
    assert.deepEqual(frames.map((frame) => [frame.opcode, frame.masked, frame.payload.length]),
        [[0x1, true, 7], [0x2, true, 2], [0x2, true, 70_000]]);
    assert.deepEqual(results, [null, null, null]);
    ws.close();
    assert.equal(readClientFrame(written.at(-1)).opcode, 0x8);
    const after = [];
    ws.send('x', { binary: false }, (error) => after.push(error?.code));
    assert.deepEqual(after, ['PROVIDER_TERMINAL_DISCONNECTED']);
});

// ---- the relay handshake -----------------------------------------------

const lease = { id: 'generation-1', isCurrent: () => true };

test('the upgrade goes through the checked-out relay with the Router-only auth header and no extension', async () => {
    const relay = fakeRelayManager((request) => upgradeAnswer(request.headers['sec-websocket-key']));
    const plan = providerPlan({ lease });
    const transport = await openProviderTerminalTransport({
        plan, lease, relayManager: relay, authInfo: JSON.stringify({ routerServiceToken: 'tok' }),
    });
    const [checkout] = relay.checkouts;
    assert.equal(checkout.authorized, true);
    assert.equal(checkout.plan.targetPath, '/fixture/terminal-control');
    assert.equal(checkout.request.plan.transport, 'websocket');
    const sent = relay.streams[0].request;
    assert.equal(sent.method, 'GET');
    assert.equal(sent.path, '/fixture/terminal-control');
    assert.equal(sent.headers['x-ploinky-auth-info'], JSON.stringify({ routerServiceToken: 'tok' }));
    assert.equal(sent.headers['sec-websocket-version'], '13');
    assert.equal(sent.headers['sec-websocket-extensions'], undefined);
    assert.equal(sent.headers.host, '127.0.0.1:7300');
    // A frame the worker pushes right after the 101 reaches the channel.
    const received = [];
    transport.on('message', (data, binary) => received.push([String(data), binary]));
    relay.streams[0].push(serverFrame(0x1, '{"v":1,"type":"challenge"}'));
    await flush();
    assert.deepEqual(received, [['{"v":1,"type":"challenge"}', false]]);
    transport.close();
    await flush();
    assert.equal(checkout.closed >= 1, true, 'the checkout is released when the transport closes');
});

test('a wrong accept key, an extension, a refusal or an abort release the checkout and reject', async () => {
    const scenarios = {
        'wrong accept': (request) => upgradeAnswer(request.headers['sec-websocket-key'], { accept: 'AAAA' }),
        'negotiated extension': (request) => upgradeAnswer(request.headers['sec-websocket-key'],
            { headers: { 'sec-websocket-extensions': 'permessage-deflate' } }),
        'refusal': () => Buffer.from('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n'),
    };
    for (const [name, respond] of Object.entries(scenarios)) {
        const relay = fakeRelayManager(respond);
        await assert.rejects(openProviderTerminalTransport({
            plan: providerPlan({ lease }), lease, relayManager: relay, authInfo: '{}',
        }), /Provider terminal/, name);
        assert.equal(relay.checkouts[0].closed >= 1, true, `${name}: checkout released`);
    }
    const relay = fakeRelayManager(() => null);
    const controller = new AbortController();
    const opening = openProviderTerminalTransport({
        plan: providerPlan({ lease }), lease, relayManager: relay, authInfo: '{}', signal: controller.signal,
    });
    await flush();
    controller.abort();
    await assert.rejects(opening, /Provider terminal/);
    assert.equal(relay.checkouts[0].closed >= 1, true);
    await assert.rejects(openProviderTerminalTransport({
        plan: providerPlan({ lease }), lease, relayManager: null, authInfo: '{}',
    }), /Provider terminal/);
});
