import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { inspect } from 'node:util';

import {
    harness, connect, launch, startRotation, finishRotation, flush, fields,
    OWNER, GENERATION, PTY, OTHER, OPERATION, SECRET,
} from './helpers/providerTerminalTransport.mjs';

const claims = (jws) => JSON.parse(Buffer.from(jws.split('.')[1], 'base64url').toString('utf8'));
const upgradeClaims = (opening) => claims(JSON.parse(opening.headers['x-ploinky-auth-info']).routerServiceToken);

function cleaned(h) {
    assert.equal(h.clock.timers.size, 0);
    for (const transport of h.transports) {
        assert.equal(transport.closed, 1);
        assert.equal(transport.listenerCount('message'), 0);
        assert.equal(transport.listenerCount('error'), 0);
        assert.equal(transport.listenerCount('close'), 0);
    }
}

test('fresh token per connection, exact possession proof, make-before-break and stale-channel fencing', async () => {
    const h = harness();
    const old = await connect(h);
    await launch(h, old);
    await h.client.attach(PTY, { lease: h.lease });
    const output = [];
    h.client.on('output', (entry) => output.push(entry.sequence));
    old.output(PTY, 1n);
    const lateHandler = old.listeners('message')[0];
    const rotation = await startRotation(h);
    assert.equal(old.closed, 0);
    assert.equal(rotation.transport.controls('hello').length, 0);
    const parts = [rotation.transport.nonce, OWNER, GENERATION].map((item) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(Buffer.byteLength(item));
        return Buffer.concat([length, Buffer.from(item)]);
    });
    const proof = createHmac('sha256', Buffer.from(SECRET, 'base64url')).update(Buffer.concat(parts)).digest('base64url');
    assert.equal(rotation.transport.controls('reattach')[0].proof === proof, true);
    assert.equal(h.openings[0].headers['x-ploinky-auth-info'] === h.openings[1].headers['x-ploinky-auth-info'], false);
    // Hello tokens are minted after `challenge`, bound to that transport's own
    // nonce, fresh per connection, and present in both hello and reattach.
    assert.notEqual(old.nonce, rotation.transport.nonce);
    const helloToken = old.controls('hello')[0].helloToken;
    const reattachToken = rotation.transport.controls('reattach')[0].helloToken;
    assert.equal(typeof helloToken, 'string');
    assert.equal(typeof reattachToken, 'string');
    const helloClaims = claims(helloToken);
    const reattachClaims = claims(reattachToken);
    assert.equal(helloClaims.purpose, 'execution-provider-terminal-hello');
    assert.equal(reattachClaims.purpose, 'execution-provider-terminal-hello');
    assert.equal(helloClaims.nonce, old.nonce);
    assert.equal(reattachClaims.nonce, rotation.transport.nonce);
    assert.equal(upgradeClaims(h.openings[0]).purpose, 'execution-provider-terminal');
    assert.equal(Object.hasOwn(upgradeClaims(h.openings[0]), 'nonce'), false);
    const jtis = [helloClaims.jti, reattachClaims.jti, upgradeClaims(h.openings[0]).jti, upgradeClaims(h.openings[1]).jti];
    assert.equal(new Set(jtis).size, 4);
    await finishRotation(rotation, [{ ptySessionId: PTY, inputNext: '1', outputLast: '1' }]);
    assert.equal(old.closed, 1);
    lateHandler(JSON.stringify({ v: 1, type: 'ended', ptySessionId: PTY, cause: 'exit' }), false);
    await assert.rejects(h.client.input(PTY, Buffer.from('x'), { lease: h.lease }), /not_attached/);
    await h.client.attach(PTY, { lease: h.lease });
    rotation.transport.output(PTY, 1n);
    rotation.transport.output(PTY, 2n);
    assert.deepEqual(output, [1n, 2n]);
    const snapshot = inspect(h.client, { showHidden: true });
    assert.equal(snapshot.includes(SECRET), false);
    assert.equal(snapshot.includes(proof), false);
    assert.deepEqual(await h.client.shutdown(), { localClosed: true, remoteTerminationProven: false });
    cleaned(h);
});

test('immutable launch fields, identical in-flight promise, conflicting reuse and fresh evidence', async () => {
    const h = harness();
    const transport = await connect(h);
    const input = fields({ project: { selection: 'opaque', relativePath: '' } });
    const first = h.client.launch(input, { lease: h.lease });
    const duplicate = h.client.launch(input, { lease: h.lease });
    assert.equal(first, duplicate);
    await assert.rejects(h.client.launch({ ...input, cols: 81 }, { lease: h.lease }), /operation_conflict/);
    input.project.selection = 'mutated';
    await flush();
    assert.equal(h.evidence[0].launch.project.selection, 'opaque');
    assert.equal(Object.isFrozen(h.evidence[0].launch.project), true);
    assert.equal(h.evidence[0].tool, '__provider_terminal_launch__');
    assert.equal(h.evidence[0].method, 'LAUNCH');
    assert.equal(transport.controls('launch').length, 1);
    transport.peer('launched', { operationId: OPERATION, ptySessionId: PTY });
    assert.equal(await first, PTY);
    assert.equal(await duplicate, PTY);
    transport.peer('launched', { operationId: OPERATION, ptySessionId: PTY });
    await h.client.shutdown();
    cleaned(h);
});

test('lost launch preserves operation and capacity; inventory never correlates unknown PTYs', async () => {
    const h = harness({ limits: { operations: 1 } });
    const old = await connect(h);
    const first = h.client.launch(fields(), { lease: h.lease });
    const uncertain = assert.rejects(first, /launch_uncertain/);
    await h.clock.advance(100);
    await uncertain;
    old.peer('launched', { operationId: OPERATION, ptySessionId: OTHER });
    await assert.rejects(h.client.attach(OTHER, { lease: h.lease }), /unknown_pty/);
    await assert.rejects(h.client.launch(fields({ operationId: OTHER }), { lease: h.lease }), /capacity/);
    const rotation = await startRotation(h);
    await finishRotation(rotation, [{ ptySessionId: OTHER, inputNext: '1', outputLast: '0' }]);
    await assert.rejects(h.client.attach(OTHER, { lease: h.lease }), /unknown_pty/);
    const retry = h.client.launch(fields(), { lease: h.lease });
    await flush();
    assert.equal(h.evidence.length, 2);
    assert.equal(h.evidence[0].rch, h.evidence[1].rch);
    assert.equal(old.controls('launch')[0].launchEvidence === rotation.transport.controls('launch')[0].launchEvidence, false);
    rotation.transport.peer('launched', { operationId: OPERATION, ptySessionId: OTHER });
    assert.equal(await retry, OTHER);
    await h.client.shutdown();
    cleaned(h);
});

test('stale authorization after asynchronous evidence prevents dispatch', async () => {
    let resolve;
    const h = harness({ evidence: () => new Promise((done) => { resolve = done; }) });
    const transport = await connect(h);
    const result = h.client.launch(fields(), { lease: h.lease });
    const rejected = assert.rejects(result, /launch_uncertain/);
    await flush();
    h.lease.current = false;
    resolve('synthetic-evidence');
    await rejected;
    assert.equal(transport.controls('launch').length, 0);
    await h.client.shutdown();
    cleaned(h);
});

test('stale leases during token mint and open cannot publish or send hello', async () => {
    let resolveToken;
    const h = harness({ service: { mint: () => new Promise((resolve) => { resolveToken = resolve; }) } });
    const first = assert.rejects(h.client.connect({ lease: h.lease }), /connect_failed/);
    await flush();
    h.lease.current = false;
    resolveToken('synthetic-service-token');
    await first;
    assert.equal(h.openings.length, 0);
    await h.client.shutdown();
    cleaned(h);

    let resolveOpen;
    const other = harness({ open: () => new Promise((resolve) => { resolveOpen = resolve; }) });
    const second = assert.rejects(other.client.connect({ lease: other.lease }), /connect_failed/);
    await flush();
    other.lease.current = false;
    resolveOpen();
    await second;
    assert.equal(other.transports[0].sent.length, 0);
    await other.client.shutdown();
    cleaned(other);
});

test('stale lease during the hello mint sends no hello and leaves a later connect possible', async () => {
    let resolveHello;
    const minted = [];
    const service = {
        mint: (input) => {
            minted.push(input);
            if (input.purpose) return new Promise((resolve) => { resolveHello = resolve; });
            return Promise.resolve('synthetic-upgrade-token');
        },
    };
    const h = harness({ service });
    const first = assert.rejects(h.client.connect({ lease: h.lease }), /connect_failed/);
    await flush();
    const transport = h.transports[0];
    assert.equal(minted.length, 1, 'no hello token is minted before challenge');
    transport.peer('challenge', { nonce: transport.nonce });
    await flush();
    assert.equal(minted.length, 2);
    assert.equal(minted[1].purpose, 'execution-provider-terminal-hello');
    assert.equal(minted[1].nonce, transport.nonce);
    assert.equal(transport.sent.length, 0, 'nothing is sent while the mint is pending');
    h.lease.current = false;
    resolveHello('synthetic-hello-token');
    await first;
    assert.equal(transport.sent.length, 0);
    assert.equal(transport.controls('hello').length, 0);
    // No hello was sent, so the latch is unset and a fresh lease may connect.
    h.lease.current = true;
    const second = assert.rejects(h.client.connect({ lease: h.lease }), /connect_failed/);
    await flush();
    assert.equal(h.openings.length, 2);
    await h.client.shutdown();
    await second;
    cleaned(h);
});

test('hello mint failure after challenge sends nothing and a later connect is allowed', async () => {
    let failHello = true;
    const h = harness({ service: {
        mint: async (input) => {
            if (input.purpose && failHello) throw new Error('mint failed');
            return input.purpose ? `hello-token-${input.nonce}` : 'synthetic-upgrade-token';
        },
    } });
    const failed = assert.rejects(h.client.connect({ lease: h.lease }), /connect_failed/);
    await flush();
    const first = h.transports[0];
    first.peer('challenge', { nonce: first.nonce });
    await failed;
    assert.equal(first.sent.length, 0);
    failHello = false;
    const second = await connect(h);
    assert.equal(h.transports.length, 2);
    assert.equal(second.controls('hello')[0].helloToken, `hello-token-${second.nonce}`);
    assert.equal(first.controls('hello').length, 0);
    await h.client.shutdown();
    cleaned(h);
});

test('a minted hello token the frame schema rejects sends nothing and a later connect still succeeds', async () => {
    for (const bad of ['', 42, 'x'.repeat(12 * 1024 + 1)]) {
        let useBad = true;
        const h = harness({ service: {
            mint: async (input) => {
                if (!input.purpose) return 'synthetic-upgrade-token';
                return useBad ? bad : `hello-token-${input.nonce}`;
            },
        } });
        const failed = assert.rejects(h.client.connect({ lease: h.lease }), /connect_failed/);
        await flush();
        const first = h.transports[0];
        first.peer('challenge', { nonce: first.nonce });
        await failed;
        assert.equal(first.sent.length, 0);
        useBad = false;
        const second = await connect(h);
        assert.equal(h.transports.length, 2);
        assert.equal(second.controls('hello')[0].helloToken, `hello-token-${second.nonce}`);
        await h.client.shutdown();
        cleaned(h);
    }
});

test('hello mint that outlasts handshakeMs fails the connect without sending', async () => {
    const h = harness({ service: {
        mint: (input) => (input.purpose ? new Promise(() => {}) : Promise.resolve('synthetic-upgrade-token')),
    } });
    const failed = assert.rejects(h.client.connect({ lease: h.lease }), /connect_failed/);
    await flush();
    const transport = h.transports[0];
    transport.peer('challenge', { nonce: transport.nonce });
    await flush();
    await h.clock.advance(200);
    await failed;
    assert.equal(transport.sent.length, 0);
    await h.client.shutdown();
    cleaned(h);
});

test('routing staleness blocks caller actions but established heartbeat maintains ownership', async () => {
    const h = harness();
    const transport = await connect(h);
    await launch(h, transport);
    await h.client.attach(PTY, { lease: h.lease });
    h.lease.current = false;
    await assert.rejects(h.client.input(PTY, Buffer.from('x'), { lease: h.lease }), /stale_lease/);
    assert.throws(() => h.client.resize(PTY, 80, 24, { lease: h.lease }), /stale_lease/);
    await assert.rejects(h.client.rotate({ lease: h.lease }), /stale_lease/);
    await h.clock.advance(1000);
    assert.equal(transport.controls('heartbeat').length, 1);
    transport.peer('heartbeat-ok', { leaseExpiresAt: 13 });
    await h.clock.advance(1000);
    assert.equal(transport.controls('heartbeat').length, 2);
    transport.peer('heartbeat-ok', { leaseExpiresAt: 14 });
    assert.equal(transport.closed, 0);
    await h.client.shutdown();
    cleaned(h);
});

test('input retention is bounded, ack frees capacity, and reconnect resends original sequence bytes', async () => {
    const h = harness({ limits: { inputBytes: 54 } });
    const old = await connect(h);
    await launch(h, old);
    await h.client.attach(PTY, { lease: h.lease });
    assert.equal(await h.client.input(PTY, Buffer.from('a'), { lease: h.lease }), 1n);
    assert.equal(await h.client.input(PTY, Buffer.from('b'), { lease: h.lease }), 2n);
    await assert.rejects(h.client.input(PTY, Buffer.from('c'), { lease: h.lease }), /backpressure/);
    old.peer('ack', { ptySessionId: PTY, sequence: '1' });
    old.peer('ack', { ptySessionId: PTY, sequence: '1' });
    assert.equal(await h.client.input(PTY, Buffer.from('c'), { lease: h.lease }), 3n);
    const rotation = await startRotation(h);
    await finishRotation(rotation, [{ ptySessionId: PTY, inputNext: '2', outputLast: '0' }]);
    await h.client.attach(PTY, { lease: h.lease });
    assert.deepEqual(rotation.transport.sent.filter((entry) => entry.binary).map((entry) => entry.data),
        old.sent.filter((entry) => entry.binary).slice(1).map((entry) => entry.data));
    rotation.transport.peer('ack', { ptySessionId: PTY, sequence: '3' });
    assert.equal(await h.client.input(PTY, Buffer.from('d'), { lease: h.lease }), 4n);
    await h.client.shutdown();
    cleaned(h);
});

test('unknown peer PTYs never create state; gap requires explicit attach cursor; ended is the only ended event', async () => {
    const h = harness();
    const transport = await connect(h);
    const ended = [];
    const gaps = [];
    h.client.on('ended', (entry) => ended.push(entry));
    h.client.on('gap', (entry) => gaps.push(entry));
    transport.output(OTHER, 1n);
    transport.peer('ack', { ptySessionId: OTHER, sequence: '1' });
    transport.peer('ended', { ptySessionId: OTHER, cause: 'exit' });
    transport.peer('launched', { operationId: OTHER, ptySessionId: OTHER });
    await assert.rejects(h.client.attach(OTHER, { lease: h.lease }), /unknown_pty/);
    assert.throws(() => h.client.resize(OTHER, 80, 24, { lease: h.lease }), /unknown_pty/);
    await launch(h, transport);
    await h.client.attach(PTY, { lease: h.lease });
    transport.peer('gap', { ptySessionId: PTY, firstAvailable: '5' });
    assert.equal(gaps[0].firstAvailable, 5n);
    await assert.rejects(h.client.input(PTY, Buffer.from('x'), { lease: h.lease }), /not_attached/);
    await h.client.attach(PTY, { lease: h.lease, afterOutputSequence: 4n });
    transport.output(PTY, 5n);
    const one = h.client.close(PTY, { lease: h.lease });
    const two = h.client.close(PTY, { lease: h.lease });
    assert.equal(one, two);
    await one;
    assert.equal(transport.controls('close').length, 1);
    assert.equal(ended.length, 0);
    transport.peer('ended', { ptySessionId: PTY, cause: 'exit', exitCode: 0 });
    assert.equal(ended.length, 1);
    const shutdown = h.client.shutdown();
    assert.equal(shutdown, h.client.shutdown());
    await shutdown;
    cleaned(h);
});
