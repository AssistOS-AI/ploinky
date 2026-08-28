import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
    AGENT_WORKER_CLOSE_GRACE_MS,
    AGENT_WORKER_RESPONSE_TIMEOUT_MS,
    AgentWebttyWorkerClient,
    WEBTTY_AGENT_WORKER_INVOCATION,
} from '../../cli/server/webtty/agentWorkerClient.mjs';
import { WEBTTY_AGENT_BACKEND, agentWorkerMessage } from '../../cli/server/webtty/agentWorkerProtocol.mjs';

const TERMINAL_ID = 'abcdefghijklmnopqrstuvwx';
const WORKER_PATH = '/opt/ploinky/agentTerminalWorker.mjs';

test('Router response deadline leaves a bounded margin for the worker readiness result', () => {
    assert.equal(AGENT_WORKER_RESPONSE_TIMEOUT_MS, 11_000);
    assert.equal(AGENT_WORKER_RESPONSE_TIMEOUT_MS > 10_000, true);
    assert.equal(AGENT_WORKER_RESPONSE_TIMEOUT_MS < AGENT_WORKER_CLOSE_GRACE_MS + 10_000, true);
});

class FakeChild extends EventEmitter {
    constructor() {
        super();
        this.pid = 4100;
        this.connected = true;
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
        this.messages = [];
        this.kills = [];
    }

    send(message, callback) {
        this.messages.push(message);
        callback?.(null);
    }

    kill(signal) {
        this.kills.push(signal);
        queueMicrotask(() => this.emit('exit', null, signal));
        return true;
    }
}

function workerIdentity(overrides = {}) {
    return {
        pid: 4100,
        state: 'S',
        pgrp: 4100,
        session: 4100,
        startToken: 'linux-proc:41000',
        uid: 1000,
        cmdline: ['/usr/local/bin/node', WORKER_PATH, WEBTTY_AGENT_WORKER_INVOCATION],
        ...overrides,
    };
}

function readyEvidence() {
    return {
        backend: WEBTTY_AGENT_BACKEND,
        runtime: 'podman',
        containerId: 'a'.repeat(64),
        targetUser: '1000:1000',
        translatedCwd: '/workspace/demo',
        marker: 'marker_abcdefghijklmnopqrstuvwx',
        execId: 'b'.repeat(64),
        clientProcess: {
            pid: 4200,
            uid: 1000,
            startToken: 'linux-proc:42000',
            processGroupId: 4200,
            sessionId: 4200,
            foregroundProcessGroupId: 4200,
            ttyNumber: 34816,
        },
        innerProcess: {
            boxPid: 4300,
            boxStartToken: 'linux-proc:43000',
            boxProcessGroupId: 4300,
            boxSessionId: 4300,
            pidNamespace: 'pid:[9001]',
            nspid: [4300, 42],
            nspgid: [4300, 42],
            nssid: [4300, 42],
            innerPid: 42,
            innerProcessGroupId: 42,
            innerSessionId: 42,
            innerUid: 1000,
            innerStartToken: 'linux-proc:43000',
            containerInitBoxPid: 4299,
            containerInitStartToken: 'linux-proc:42990',
        },
    };
}

function startupEvidence(overrides = {}) {
    return {
        backend: WEBTTY_AGENT_BACKEND,
        runtime: 'podman',
        containerId: 'a'.repeat(64),
        targetUser: '1000:1000',
        translatedCwd: '/workspace/demo',
        marker: 'marker_abcdefghijklmnopqrstuvwx',
        baselineExecIds: [],
        containerInitProcess: {
            pid: 4299,
            startToken: 'linux-proc:42990',
            pidNamespace: 'pid:[9001]',
        },
        ...overrides,
    };
}

function harness(overrides = {}) {
    const child = new FakeChild();
    const forkCalls = [];
    const signals = [];
    const client = new AgentWebttyWorkerClient({
        terminalId: TERMINAL_ID,
        workerPath: WORKER_PATH,
        forkImpl: (...args) => { forkCalls.push(args); return child; },
        readProcessIdentity: overrides.readProcessIdentity || (async () => workerIdentity()),
        signalProcess: (pid, signal) => signals.push([pid, signal]),
        closeGraceMs: overrides.closeGraceMs ?? 5,
    });
    return { child, client, forkCalls, signals };
}

test('agent client forks a separate fixed worker with a scrubbed environment', async () => {
    const h = harness();
    assert.deepEqual(await h.client.spawn(), {
        pid: 4100,
        startToken: 'linux-proc:41000',
        uid: 1000,
    });
    assert.equal(h.forkCalls.length, 1);
    assert.deepEqual(h.forkCalls[0][1], [WEBTTY_AGENT_WORKER_INVOCATION]);
    assert.deepEqual(Object.keys(h.forkCalls[0][2].env).sort(), [
        'HOME', 'LANG', 'LC_ALL', 'LOGNAME', 'PATH', 'USER',
    ]);
});

test('start accepts exact ready evidence and preserves ordered I/O messages', async () => {
    const h = harness();
    await h.client.spawn();
    const prepared = h.client.prepare({
        runtime: 'podman',
        containerId: 'a'.repeat(64),
        targetUser: '1000:1000',
        translatedCwd: '/workspace/demo',
        marker: 'marker_abcdefghijklmnopqrstuvwx',
        cols: 80,
        rows: 24,
    });
    await new Promise((resolve) => setImmediate(resolve));
    h.child.emit('message', agentWorkerMessage('prepared', TERMINAL_ID, {
        startupEvidence: startupEvidence(),
    }));
    assert.deepEqual((await prepared).startupEvidence.baselineExecIds, []);
    const started = h.client.start();
    await new Promise((resolve) => setImmediate(resolve));
    h.child.emit('message', agentWorkerMessage('ready', TERMINAL_ID, {
        recoveryEvidence: readyEvidence(),
    }));
    assert.equal((await started).recoveryEvidence.execId, 'b'.repeat(64));
    await h.client.input('pwd\r');
    await h.client.resize(120, 40);
    assert.deepEqual(h.child.messages.map((message) => message.type), [
        'init-agent', 'start-agent', 'input', 'resize',
    ]);
});

test('ready evidence must exactly match the server-selected init identity and cwd', async () => {
    for (const mismatch of [
        { targetUser: '0:0' },
        { translatedCwd: '/workspace/different' },
        { containerId: 'c'.repeat(64) },
        { marker: 'marker_differentabcdefghijklmnop' },
    ]) {
        const h = harness();
        await h.client.spawn();
        const failures = [];
        h.client.on('error-category', (entry) => failures.push(entry.category));
        const prepared = h.client.prepare({
            runtime: 'podman',
            containerId: 'a'.repeat(64),
            targetUser: '1000:1000',
            translatedCwd: '/workspace/demo',
            marker: 'marker_abcdefghijklmnopqrstuvwx',
            cols: 80,
            rows: 24,
        });
        await new Promise((resolve) => setImmediate(resolve));
        h.child.emit('message', agentWorkerMessage('prepared', TERMINAL_ID, {
            startupEvidence: startupEvidence(),
        }));
        await prepared;
        const started = h.client.start();
        await new Promise((resolve) => setImmediate(resolve));
        h.child.emit('message', agentWorkerMessage('ready', TERMINAL_ID, {
            recoveryEvidence: { ...readyEvidence(), ...mismatch },
        }));
        h.child.emit('exit', 1, null);
        await assert.rejects(started, /exited before ready/);
        assert.deepEqual(failures, ['protocol_error']);
    }
});

test('malformed or out-of-order worker output fails the provider only', async () => {
    const h = harness();
    await h.client.spawn();
    const failures = [];
    h.client.on('error-category', (entry) => failures.push(entry.category));
    h.child.emit('message', agentWorkerMessage('output', TERMINAL_ID, {
        sequence: 1,
        data: 'before-ready',
    }));
    assert.deepEqual(failures, ['protocol_error']);
    assert.equal(h.client.closing, true);
});

test('forced worker cleanup signals only an exact revalidated worker PID', async () => {
    const h = harness({ closeGraceMs: 1 });
    await h.client.spawn();
    await h.client.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(h.signals, [[4100, 'SIGKILL']]);

    let reads = 0;
    const changed = harness({
        closeGraceMs: 1,
        readProcessIdentity: async () => {
            reads += 1;
            return workerIdentity(reads === 1 ? {} : { startToken: 'linux-proc:99999' });
        },
    });
    await changed.client.spawn();
    const failures = [];
    changed.client.on('error-category', (entry) => failures.push(entry.category));
    await changed.client.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(changed.signals, []);
    assert.deepEqual(failures, ['worker_cleanup_unproven']);
});

test('close deadline is independent of a wedged IPC send callback', async () => {
    const h = harness({ closeGraceMs: 5 });
    h.child.send = function send(message) {
        this.messages.push(message);
        return false;
    };
    await h.client.spawn();
    await h.client.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(h.signals, [[4100, 'SIGKILL']]);
    assert.equal(h.client.queuedBytes, 0);
});

test('default cleanup grace does not preempt a worker that proves cleanup after two seconds', async () => {
    assert.ok(AGENT_WORKER_CLOSE_GRACE_MS < 9_000);
    const h = harness({ closeGraceMs: AGENT_WORKER_CLOSE_GRACE_MS });
    await h.client.spawn();
    const closing = h.client.close();
    setTimeout(() => h.child.emit('exit', 0, null), 2_100);
    await closing;
    assert.equal(await h.client.waitForExit(2_500), true);
    assert.deepEqual(h.signals, []);
});

test('identity-capture failure reclaims the exact fork before rejecting startup', async () => {
    const h = harness({
        closeGraceMs: 1,
        readProcessIdentity: async () => { throw new Error('proc unavailable'); },
    });
    await assert.rejects(h.client.spawn(), { code: 'WEBTTY_AGENT_WORKER_IDENTITY_UNPROVEN' });
    assert.deepEqual(h.child.messages.map((message) => message.type), ['close']);
    assert.deepEqual(h.child.kills, ['SIGKILL']);
    assert.equal(await h.client.waitForExit(), true);
});

test('worker exit during init send rejects immediately instead of waiting for timeout', async () => {
    const h = harness();
    await h.client.spawn();
    h.child.send = function send(message, callback) {
        this.messages.push(message);
        callback?.(null);
        if (message.type === 'init-agent') this.emit('exit', 1, null);
    };
    await assert.rejects(h.client.prepare({
        runtime: 'podman',
        containerId: 'a'.repeat(64),
        targetUser: '1000:1000',
        translatedCwd: '/workspace/demo',
        marker: 'marker_abcdefghijklmnopqrstuvwx',
        cols: 80,
        rows: 24,
    }), /exited before prepared/);
});

test('worker error during start send is retained and rejects readiness immediately', async () => {
    const h = harness();
    await h.client.spawn();
    const prepared = h.client.prepare({
        runtime: 'podman',
        containerId: 'a'.repeat(64),
        targetUser: '1000:1000',
        translatedCwd: '/workspace/demo',
        marker: 'marker_abcdefghijklmnopqrstuvwx',
        cols: 80,
        rows: 24,
    });
    await new Promise((resolve) => setImmediate(resolve));
    h.child.emit('message', agentWorkerMessage('prepared', TERMINAL_ID, {
        startupEvidence: startupEvidence(),
    }));
    await prepared;
    h.child.send = function send(message, callback) {
        this.messages.push(message);
        if (message.type === 'start-agent') {
            this.emit('message', agentWorkerMessage('error', TERMINAL_ID, {
                category: 'readiness',
            }));
        }
        callback?.(null);
    };
    await assert.rejects(h.client.start(), (error) => (
        error.code === 'WEBTTY_AGENT_WORKER_TERMINAL_ERROR'
        && error.category === 'readiness'
        && /reported readiness before ready/.test(error.message)
    ));
});

test('controlled close does not misclassify IPC disconnect before process exit', async () => {
    const h = harness();
    await h.client.spawn();
    const failures = [];
    h.client.on('error-category', (entry) => failures.push(entry.category));
    await h.client.close();
    h.child.emit('disconnect');
    h.child.emit('exit', 0, null);
    assert.deepEqual(failures, []);
    assert.equal(await h.client.waitForExit(), true);
});
