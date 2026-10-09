// Exit paths of the live run: no stream may survive an early exit or a failing
// ownership guard, and a stuck run must always be able to terminate.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { closeAllOpenStreams, createStreamHandle, openEventStream, openStreamCount, runWebchatProbes } from './webchat-probes.mjs';
import { armExitDeadline, installInterruptHandlers, runOwnedCleanup } from './run-cleanup.mjs';

function fakeResponse() {
    const res = new EventEmitter();
    Object.assign(res, { statusCode: 200, headers: { 'content-type': 'text/event-stream' }, destroyed: false, setEncoding() {}, destroy() { res.destroyed = true; res.emit('close'); } });
    return res;
}
const sseFrame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

test('a real quiet stream is closed by the unconditional cleanup even when every guarded cleanup is skipped', { timeout: 5000 }, async t => {
    // A loopback server that never ends the response: the situation that kept the run alive.
    let serverSideClosed = false;
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': connected\n\n');
        res.on('close', () => { serverSideClosed = true; });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { closeAllOpenStreams(); server.closeAllConnections(); server.close(); });
    const { port } = server.address();
    let guardBroken = false;
    const ctx = { report: { requests: [], cleanup: [] }, secrets: new Set(), finalizers: [], clients: { userA: { cookies: [] } },
        async guard() { if (guardBroken) throw new Error('ownership guard failed'); } };
    const handle = await openEventStream(ctx, 'userA', '/webchat/stream?agent=dpuAgent', { request: (options, onResponse) => http.request({ ...options, port }, onResponse) });
    assert.equal(handle.status, 200);
    assert.equal(openStreamCount(), 1);
    guardBroken = true;
    let cleanupRan = false;
    await runOwnedCleanup(ctx, [async () => { cleanupRan = true; }]);
    assert.equal(cleanupRan, false, 'the guarded cleanup was skipped');
    assert.deepEqual(ctx.report.cleanup.map(entry => entry.status), ['FAIL']);
    assert.equal(openStreamCount(), 0);
    for (let i = 0; i < 50 && !serverSideClosed; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(serverSideClosed, true, 'the socket was really closed');
});

test('early WebChat exit plus a failing ownership guard still closes every opened stream', async () => {
    const responses = [];
    const openStream = async () => {
        const res = fakeResponse();
        responses.push(res);
        const handle = createStreamHandle(res, null);
        queueMicrotask(() => res.emit('data', sseFrame('startup-state', { state: 'failed' })));
        return handle;
    };
    const ctx = {
        prefix: 'authz-test', secrets: new Set(), principals: { userA: { id: 'a' }, userB: { id: 'b' } }, finalizers: [], cleanups: [],
        report: { checks: [], gaps: [], requests: [], cleanup: [] },
        cleanup(fn) { this.cleanups.push(fn); },
        guardBroken: false,
        async guard() { if (this.guardBroken) throw new Error('ownership guard failed'); },
        recordGap(id) { this.report.gaps.push(id); },
        async request() { throw new Error('no request expected'); },
        async check(id, fn) { try { await fn(); this.report.checks.push({ id, status: 'PASS' }); } catch (error) { this.report.checks.push({ id, status: error?.code === 'ERR_ASSERTION' ? 'FAIL' : 'ERROR' }); } },
    };
    // The runtime reports failed, so the opening check fails and the probes return early with the stream still open.
    await runWebchatProbes(ctx, { openStream, inspectProcesses: async () => [], timing: { readyMs: 200, readyPollMs: 2 } });
    assert.ok(responses.length >= 1);
    assert.ok(responses.some(res => !res.destroyed), 'the early exit leaves a stream open');
    ctx.guardBroken = true;
    await runOwnedCleanup(ctx, ctx.cleanups, {});
    assert.ok(responses.every(res => res.destroyed), 'every opened stream was destroyed');
    assert.equal(openStreamCount(), 0);
    assert.ok(ctx.report.cleanup.every(entry => entry.status === 'FAIL'), 'the guarded cleanups are reported as failed, not skipped silently');
});

test('closeAllOpenStreams is idempotent and closes streams the probes never tracked', () => {
    const res = fakeResponse();
    createStreamHandle(res, null);
    assert.equal(openStreamCount(), 1);
    closeAllOpenStreams();
    assert.equal(res.destroyed, true);
    assert.equal(closeAllOpenStreams(), 0);
});

test('a second interruption closes streams and exits at once; the first only requests cleanup', () => {
    const handlers = new Map();
    const exits = [];
    const logs = [];
    let closed = 0;
    const ctx = { report: {} };
    installInterruptHandlers(ctx, { on: (signal, handler) => handlers.set(signal, handler), closeStreams: () => { closed++; }, exit: code => exits.push(code), log: message => logs.push(message) });
    handlers.get('SIGINT')();
    assert.equal(ctx.report.interrupted, 'SIGINT');
    assert.deepEqual(exits, []);
    assert.equal(closed, 0);
    handlers.get('SIGTERM')();
    assert.deepEqual(exits, [130]);
    assert.equal(closed, 1);
    assert.equal(ctx.report.interrupted, 'SIGTERM');
    assert.match(logs.at(-1), /Second interruption/);
});

test('the exit deadline is unreferenced and ends the process with the recorded exit code', () => {
    let scheduled; let unrefCalled = false; const exits = [];
    armExitDeadline(() => 2, { ms: 1234, exit: code => exits.push(code), schedule: (fn, ms) => { scheduled = { fn, ms }; return { unref() { unrefCalled = true; } }; } });
    assert.equal(scheduled.ms, 1234);
    assert.equal(unrefCalled, true, 'the timer never keeps the process alive on its own');
    scheduled.fn();
    assert.deepEqual(exits, [2]);
});
