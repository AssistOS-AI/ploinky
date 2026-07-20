import test from 'node:test';
import assert from 'node:assert/strict';

import {
    RelayFrameDecoder,
    decodeRelayFrameBody,
    encodeRelayFrame,
} from '../../cli/server/runtimeRelay/protocol.js';

test('relay protocol decodes split and coalesced binary frames without ambiguity', () => {
    const first = encodeRelayFrame({ type: 'DATA', requestId: 'one', data: Buffer.from([0, 1, 255]) });
    const second = encodeRelayFrame({ type: 'END', requestId: 'one' });
    const decoder = new RelayFrameDecoder();
    assert.deepEqual(decoder.push(first.subarray(0, 2)), []);
    const frames = decoder.push(Buffer.concat([first.subarray(2), second]));
    assert.deepEqual(frames[0].data, Buffer.from([0, 1, 255]));
    assert.equal(frames[1].type, 'END');
    decoder.end();
});
test('relay protocol rejects invalid length, malformed JSON, unknown types, and truncation', () => {
    const zero = Buffer.alloc(4);
    assert.throws(() => new RelayFrameDecoder().push(zero), /invalid frame length/);
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(33, 0);
    assert.throws(() => new RelayFrameDecoder({ maxFrameBytes: 32 }).push(oversized), /invalid frame length/);
    assert.throws(() => decodeRelayFrameBody(Buffer.from('{')), /malformed JSON/);
    assert.throws(() => encodeRelayFrame({ type: 'INVENTED' }), /unknown frame type/);
    const decoder = new RelayFrameDecoder();
    decoder.push(encodeRelayFrame({ type: 'READY' }).subarray(0, 5));
    assert.throws(() => decoder.end(), /truncated frame/);
});

test('relay protocol rejects malformed encoded data', () => {
    assert.throws(
        () => decodeRelayFrameBody(Buffer.from(JSON.stringify({
            type: 'DATA',
            dataEncoding: 'base64',
            data: '***',
        }))),
        /malformed base64/,
    );
});
