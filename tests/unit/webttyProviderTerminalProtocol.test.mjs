import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
    decodeTerminalControl, encodeTerminalControl, decodeTerminalData, encodeTerminalData,
    terminalPossessionProof, terminalLaunchHash, U64_MAX,
} from '../../cli/server/webtty/providerTerminalProtocol.mjs';

const ID = '12345678-1234-4234-8234-123456789abc';
const GEN = '87654321-4321-4321-a321-cba987654321';
const SECRET = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const NONCE = 'ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8';
const launch = { operationId: ID, targetId: 'opaque-target', project: null, cols: 80, rows: 24 };

test('binary header has independent exact UUID and big-endian u64 bytes', () => {
    const expected = Buffer.from('010112345678123442348234123456789abcffffffffffffffff00ff', 'hex');
    assert.deepEqual(encodeTerminalData({ ptySessionId: ID, sequence: U64_MAX,
        payload: Buffer.from([0, 255]) }), expected);
    assert.deepEqual(decodeTerminalData(expected, 'router'), {
        ptySessionId: ID, sequence: U64_MAX, payload: Buffer.from([0, 255]),
    });
    assert.throws(() => decodeTerminalData(expected));
    for (const sequence of [0n, -1n, U64_MAX + 1n, 1, NaN]) {
        assert.throws(() => encodeTerminalData({ ptySessionId: ID, sequence, payload: Buffer.alloc(0) }));
    }
    for (const frame of [expected.subarray(0, 25), Buffer.alloc(26), Buffer.alloc(65563)]) {
        assert.throws(() => decodeTerminalData(frame));
    }
    for (const id of ['', ID.toUpperCase(), ID.replace('-4234-', '-1234-'), ID.replace('-8234-', '-7234-')]) {
        assert.throws(() => encodeTerminalData({ ptySessionId: id, sequence: 1n, payload: Buffer.alloc(0) }));
    }
    assert.equal(encodeTerminalData({ ptySessionId: ID, sequence: 1n, payload: Buffer.alloc(65536) }).length, 65562);
    assert.throws(() => encodeTerminalData({ ptySessionId: ID, sequence: 1n, payload: Buffer.alloc(65537) }));
});

test('canonical decimal JSON counters preserve all u64 bits and exhausted input sentinel', () => {
    const wire = (sequence) => JSON.stringify({ v: 1, type: 'ack', ptySessionId: ID, sequence });
    assert.equal(decodeTerminalControl(wire(U64_MAX.toString())).sequence, '18446744073709551615');
    for (const value of [0, 1, 9007199254740992, '', '0', '-1', '+1', '01', '1.0', '1e1', ' 1',
        '18446744073709551616', '99999999999999999999999999']) {
        assert.throws(() => decodeTerminalControl(wire(value)));
    }
    const inventory = { v: 1, type: 'reattach-ok', leaseExpiresAt: 99,
        ptys: [{ ptySessionId: ID, inputNext: '18446744073709551616', outputLast: '0' }] };
    assert.doesNotThrow(() => encodeTerminalControl(inventory, 'worker'));
    assert.throws(() => encodeTerminalControl({ ...inventory, ptys: [inventory.ptys[0], inventory.ptys[0]] }, 'worker'));
    assert.doesNotThrow(() => encodeTerminalControl({ v: 1, type: 'attach', ptySessionId: ID,
        afterOutputSequence: '0' }));
});

test('possession proof binds length-prefixed challenge, ownership and generation', () => {
    const input = { secret: SECRET, nonce: NONCE, ownershipSessionId: ID, workerGeneration: GEN };
    // Independent vector generated from literal hexadecimal UTF-8 lengths and bytes.
    const proof = terminalPossessionProof(input);
    assert.equal(proof, 'yk2HQvGMVRAU8teQt9ZRwhJChBri3wT6JAipDQGxAko');
    assert.notEqual(terminalPossessionProof({ ...input, nonce: SECRET }), proof);
    assert.notEqual(terminalPossessionProof({ ...input, ownershipSessionId: GEN }), proof);
    assert.notEqual(terminalPossessionProof({ ...input, workerGeneration: ID }), proof);
    assert.throws(() => terminalPossessionProof({ ...input, secret: `${SECRET}=` }));
});

test('launch hash uses exactly canonical immutable launch fields', () => {
    const canonical = `{"cols":80,"operationId":"${ID}","project":null,"rows":24,"targetId":"opaque-target"}`;
    assert.equal(terminalLaunchHash(launch), createHash('sha256').update(canonical).digest('base64url'));
    assert.equal(terminalLaunchHash({ ...launch, launchEvidence: 'ignored' }), terminalLaunchHash(launch));
    assert.notEqual(terminalLaunchHash({ ...launch, rows: 25 }), terminalLaunchHash(launch));
});

test('control frames enforce exhaustive fields, direction, UTF-8 and byte bounds', () => {
    for (const frame of [
        { v: 2, type: 'heartbeat' }, { v: 1, type: 'heartbeat', extra: true },
        { v: 1, type: '__proto__' }, { v: 1, type: 'hello', label: '\u0000' },
        { v: 1, type: 'launch', ...launch, cols: 1, launchEvidence: 'token' },
        { v: 1, type: 'launch', ...launch, rows: 513, launchEvidence: 'token' },
    ]) assert.throws(() => encodeTerminalControl(frame));
    assert.throws(() => decodeTerminalControl('{"v":1,"type":"heartbeat"}'));
    assert.throws(() => decodeTerminalControl(Buffer.from([0xff])));
    assert.throws(() => decodeTerminalControl(' '.repeat(16385)));
    assert.throws(() => encodeTerminalControl({ v: 1, type: 'launch', ...launch,
        launchEvidence: 'x'.repeat(12288), project: { selection: 'x'.repeat(1024), relativePath: 'x'.repeat(4096) } }));
    const hello = encodeTerminalControl({ v: 1, type: 'hello', label: 'é'.repeat(64) });
    assert.equal(JSON.parse(hello).label.length, 64);
    assert.throws(() => encodeTerminalControl({ v: 1, type: 'hello', label: 'é'.repeat(65) }));
});

test('project selection stays opaque; relative root is empty and traversal is refused', () => {
    for (const relativePath of ['', 'src/folder']) {
        assert.doesNotThrow(() => terminalLaunchHash({ ...launch, project: { selection: 'opaque', relativePath } }));
    }
    for (const relativePath of ['/etc', '../x', 'x/../y', './x', 'a\\b', 'bad\npath']) {
        assert.throws(() => terminalLaunchHash({ ...launch, project: { selection: 'opaque', relativePath } }));
    }
});
