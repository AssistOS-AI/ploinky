import assert from 'node:assert/strict';
import test from 'node:test';

import {
    ProviderTerminalSessionWorker, mapProviderTerminalError, providerDimensionsFit,
} from '../../cli/server/webtty/providerTerminalSession.mjs';

const PTY = '11111111-1111-4111-8111-111111111111';
const ROUTE = 'fixture-provider';
const ADMIN = Object.freeze({ userId: 'u1' });
const codeError = (code) => Object.assign(new Error(code), { code });

// A hub that records calls and lets the test push events to the watcher.
function fakeHub(options = {}) {
    const hub = {
        calls: [], watchers: new Map(), forgotten: [],
        routingLease: () => ({ isCurrent: () => true, tag: 'fresh' }),
        async launch(route, fields, lease) {
            hub.calls.push(['launch', route, fields, lease]);
            if (options.launch) return options.launch(fields);
            return PTY;
        },
        watch(route, id, handlers) {
            hub.watchers.set(id, handlers);
            return () => hub.watchers.delete(id);
        },
        async attach(route, id, opts = {}) {
            hub.calls.push(['attach', id, opts]);
            if (options.attach) return options.attach(opts);
            return undefined;
        },
        async input(route, id, bytes) { hub.calls.push(['input', id, bytes.toString()]); if (options.input) return options.input(); return undefined; },
        async resize(route, id, cols, rows) { hub.calls.push(['resize', id, cols, rows]); return undefined; },
        async close(route, id) { hub.calls.push(['close', id]); if (options.close) return options.close(); return undefined; },
        forgetOperation(route, operationId) { hub.forgotten.push(operationId); },
    };
    return hub;
}

function worker(hub, extra = {}) {
    return new ProviderTerminalSessionWorker({
        hub, routeKey: ROUTE, target: { targetId: 'target_1', project: { selection: 'Projects', relativePath: '' } },
        adminLease: ADMIN, exitWaitMs: 30, ...extra,
    });
}

const output = (sequence, text) => ({ ptySessionId: PTY, sequence: BigInt(sequence), payload: Buffer.isBuffer(text) ? text : Buffer.from(text) });
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('start launches under the composite lease with a fresh routing member and the creating admin lease, then attaches', async () => {
    const hub = fakeHub();
    const session = worker(hub);
    assert.deepEqual(await session.start({ cols: 100, rows: 40 }), { processIdentity: null });
    const [, route, fields, lease] = hub.calls[0];
    assert.equal(route, ROUTE);
    assert.match(fields.operationId, /^[0-9a-f-]{36}$/);
    assert.deepEqual({ ...fields, operationId: undefined }, {
        operationId: undefined, targetId: 'target_1', project: { selection: 'Projects', relativePath: '' }, cols: 100, rows: 40,
    });
    assert.equal(lease.admin, ADMIN);
    assert.equal(lease.routing.tag, 'fresh');
    assert.deepEqual(hub.calls[1], ['attach', PTY, {}]);
    assert.equal(await session.spawn(), null, 'there is no worker process to record');
});

test('output is decoded as UTF-8 across frames and numbered contiguously; empty partial frames do not consume a number', async () => {
    const hub = fakeHub();
    const session = worker(hub);
    const seen = [];
    session.on('output', (message) => seen.push(message));
    await session.start({ cols: 80, rows: 24 });
    const euro = Buffer.from('€');
    hub.watchers.get(PTY).output(output(1, euro.subarray(0, 1)));
    hub.watchers.get(PTY).output(output(2, euro.subarray(1)));
    hub.watchers.get(PTY).output(output(3, 'ok'));
    assert.deepEqual(seen, [{ sequence: 1, data: '€' }, { sequence: 2, data: 'ok' }]);
});

test('input and resize go to the PTY; a refusal is mapped to the session manager codes', async () => {
    const hub = fakeHub({ input: () => { throw codeError('PROVIDER_TERMINAL_BACKPRESSURE'); } });
    const session = worker(hub);
    await session.start({ cols: 80, rows: 24 });
    await assert.rejects(session.input('ls\n'), { code: 'WEBTTY_IPC_BACKPRESSURE' });
    await session.resize(120, 30);
    assert.deepEqual(hub.calls.filter((call) => call[0] === 'resize'), [['resize', PTY, 120, 30]]);
    assert.equal(mapProviderTerminalError(codeError('PROVIDER_TERMINAL_UNKNOWN_PTY')).code, 'WEBTTY_SESSION_NOT_FOUND');
    assert.equal(mapProviderTerminalError(codeError('PROVIDER_TERMINAL_STALE_LEASE')).code, 'WEBTTY_UNAVAILABLE');
    assert.equal(mapProviderTerminalError(codeError('PROVIDER_TERMINAL_LAUNCH_FAILED')).code, 'WEBTTY_PROVIDER_LAUNCH_REFUSED');
    assert.equal(mapProviderTerminalError(codeError('PROVIDER_TERMINAL_LAUNCH_UNCERTAIN')).code, 'WEBTTY_UNAVAILABLE');
    assert.equal(mapProviderTerminalError(Object.assign(codeError('PROVIDER_TERMINAL_LAUNCH_FAILED'), { refusal: 'terminal_limit' })).reason, 'terminal_limit');
    assert.equal(mapProviderTerminalError(Object.assign(codeError('PROVIDER_TERMINAL_LAUNCH_FAILED'), { refusal: 'Bad Value' })).reason, undefined);
    assert.equal(mapProviderTerminalError(new Error('x')).code, 'WEBTTY_UNAVAILABLE');
});

test('a launch refusal forgets its operation and fails the start; nothing is watched', async () => {
    const hub = fakeHub({ launch: () => { throw codeError('PROVIDER_TERMINAL_LAUNCH_FAILED'); } });
    const session = worker(hub);
    await assert.rejects(session.start({ cols: 80, rows: 24 }), { code: 'WEBTTY_PROVIDER_LAUNCH_REFUSED' });
    assert.equal(hub.forgotten.length, 1);
    assert.equal(hub.watchers.size, 0);
    assert.equal(await session.waitForExit(), true, 'a PTY that never existed has nothing left to prove');
});

test('a worker-reported end is proven: terminal-exit carries the cause and waitForExit is true', async () => {
    const hub = fakeHub();
    const session = worker(hub);
    const exits = [];
    session.on('terminal-exit', (message) => exits.push(message));
    await session.start({ cols: 80, rows: 24 });
    hub.watchers.get(PTY).ended({ type: 'ended', ptySessionId: PTY, cause: 'exit', exitCode: 0 });
    assert.deepEqual(exits, [{ category: 'exit', cleanupProven: true }]);
    assert.equal(await session.waitForExit(), true);
    assert.equal(hub.watchers.size, 0, 'the watch is dropped at the end');
    await assert.rejects(session.input('x'), { code: 'WEBTTY_SESSION_NOT_FOUND' });
});

test('a client shutdown ends the session with cause shutdown and is not proven; so is a PTY the reconcile dropped', async () => {
    for (const [cause, name] of [['shutdown', 'client shutdown'], ['unavailable', 'dropped by reconcile']]) {
        const hub = fakeHub();
        const session = worker(hub);
        const exits = [];
        session.on('terminal-exit', (message) => exits.push(message));
        await session.start({ cols: 80, rows: 24 });
        hub.watchers.get(PTY).ended({ type: 'ended', ptySessionId: PTY, cause, local: true });
        assert.deepEqual(exits, [{ category: cause, cleanupProven: false }], name);
        assert.equal(await session.waitForExit(), false, `${name}: no proof of exit`);
    }
});

test('close sends the close frame and waits for the worker; a worker that never confirms is unconfirmed after the bound', async () => {
    const hub = fakeHub();
    const session = worker(hub);
    await session.start({ cols: 80, rows: 24 });
    await session.close();
    assert.deepEqual(hub.calls.at(-1), ['close', PTY]);
    const waiting = session.waitForExit();
    hub.watchers.get(PTY).ended({ type: 'ended', ptySessionId: PTY, cause: 'exit' });
    assert.equal(await waiting, true);

    const silent = worker(fakeHub());
    await silent.start({ cols: 80, rows: 24 });
    await silent.close();
    assert.equal(await silent.waitForExit(), false);
});

test('a close that arrives while the launch is in flight closes the PTY that appears and fails the start', async () => {
    let finish;
    const hub = fakeHub({ launch: () => new Promise((resolve) => { finish = resolve; }) });
    const session = worker(hub);
    const starting = session.start({ cols: 80, rows: 24 }).catch((error) => error);
    await flush();
    await session.close();
    assert.equal(hub.calls.some((call) => call[0] === 'close'), false, 'no PTY id is known yet');
    finish(PTY);
    const error = await starting;
    assert.equal(error.code, 'WEBTTY_AUTH_INVALID');
    assert.deepEqual(hub.calls.filter((call) => call[0] === 'close'), [['close', PTY]]);
    await assert.rejects(worker(fakeHub()).start.call(session, { cols: 80, rows: 24 }), { code: 'WEBTTY_AUTH_INVALID' });
});

test('after a rotation the watcher attaches again; a gap continues from the first available byte; a failing attach is retried', async () => {
    let failures = 2;
    const hub = fakeHub({ attach: () => { if (hub.calls.filter((c) => c[0] === 'attach').length > 1 && failures-- > 0) throw codeError('PROVIDER_TERMINAL_DISCONNECTED'); } });
    const session = worker(hub, { setTimeout: (fn) => setTimeout(fn, 1) });
    await session.start({ cols: 80, rows: 24 });
    hub.watchers.get(PTY).resumed();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const attaches = hub.calls.filter((call) => call[0] === 'attach');
    assert.equal(attaches.length, 1 + 3, 'the resume was retried until it succeeded');
    hub.watchers.get(PTY).gap({ ptySessionId: PTY, firstAvailable: 11n });
    await flush();
    assert.deepEqual(hub.calls.filter((call) => call[0] === 'attach').at(-1), ['attach', PTY, { afterOutputSequence: 10n }]);
});

test('the WebTTY dimension bounds fit the provider protocol bounds exactly', () => {
    assert.equal(providerDimensionsFit(), true);
});
