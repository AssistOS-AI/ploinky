import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { executeProcessStreaming } from '../../ploinky-box/command/execute.mjs';

function fakeChild() {
    const child = new EventEmitter();
    child.killed = [];
    child.unrefCount = 0;
    child.stdin = new EventEmitter();
    child.stdin.ended = 0;
    child.stdin.destroyed = 0;
    child.stdin.end = () => { child.stdin.ended += 1; };
    child.stdin.destroy = () => { child.stdin.destroyed += 1; };
    child.kill = (signal) => { child.killed.push(signal); return true; };
    child.unref = () => { child.unrefCount += 1; };
    return child;
}

function fakeProcess() {
    const listeners = new Map();
    return {
        listeners,
        on(signal, handler) {
            if (!listeners.has(signal)) listeners.set(signal, []);
            listeners.get(signal).push(handler);
        },
        removeListener(signal, handler) {
            const registered = listeners.get(signal) || [];
            const index = registered.indexOf(handler);
            if (index >= 0) registered.splice(index, 1);
        },
        emit(signal) {
            for (const handler of [...(listeners.get(signal) || [])]) handler();
        },
        registeredCount() {
            let total = 0;
            for (const registered of listeners.values()) total += registered.length;
            return total;
        },
    };
}

function fakeTimers() {
    const queue = [];
    return {
        setTimeoutImpl(callback) {
            const item = { callback, cleared: false };
            queue.push(item);
            return item;
        },
        clearTimeoutImpl(item) { if (item) item.cleared = true; },
        runNext() {
            const item = queue.find((entry) => !entry.cleared);
            assert.ok(item);
            item.cleared = true;
            item.callback();
        },
    };
}

function runStreaming({ onSpawn } = {}) {
    const child = fakeChild();
    const processRef = fakeProcess();
    const spawned = [];
    const promise = executeProcessStreaming('podman', ['container', 'exec'], {
        env: { PATH: '/bin' },
        processRef,
        spawnImpl: (command, args, options) => {
            spawned.push({ command, args, options });
            if (onSpawn) onSpawn(child, processRef);
            return child;
        },
    });
    return { child, processRef, spawned, promise };
}

test('a normal child close passes its exact code through', async () => {
    const { child, processRef, spawned, promise } = runStreaming();
    assert.equal(spawned[0].command, 'podman');
    assert.deepEqual(spawned[0].options.stdio, ['pipe', 'inherit', 'inherit']);
    assert.equal(processRef.registeredCount(), 2);
    child.emit('close', 23, null);
    assert.equal(await promise, 23);
    // Handlers are removed exactly once, so repeated runs cannot accumulate.
    assert.equal(processRef.registeredCount(), 0);
    assert.equal(child.listenerCount('error'), 0);
    assert.equal(child.listenerCount('close'), 0);
    assert.equal(child.stdin.listenerCount('error'), 0);
});

test('an operator SIGINT reaches the child and resolves 130', async () => {
    const { child, processRef, promise } = runStreaming({
        onSpawn: (activeChild, activeProcess) => {
            queueMicrotask(() => {
                activeProcess.emit('SIGINT');
                // The in-Box follower exits cleanly on its own cancellation
                // path; the operator's intent still decides the exit code.
                activeChild.emit('close', 0, null);
            });
        },
    });
    assert.equal(await promise, 130);
    assert.deepEqual(child.killed, ['SIGINT']);
    assert.equal(child.stdin.ended, 1);
    assert.equal(processRef.registeredCount(), 0);
});

test('an operator SIGTERM reaches the child and resolves 143', async () => {
    const { child, processRef, promise } = runStreaming({
        onSpawn: (activeChild, activeProcess) => {
            queueMicrotask(() => {
                activeProcess.emit('SIGTERM');
                activeChild.emit('close', null, 'SIGTERM');
            });
        },
    });
    assert.equal(await promise, 143);
    assert.deepEqual(child.killed, ['SIGTERM']);
    assert.equal(processRef.registeredCount(), 0);
});

test('a child killed by a signal without operator input maps to its signal code', async () => {
    const { child, promise } = runStreaming();
    child.emit('close', null, 'SIGKILL');
    assert.equal(await promise, 137);
});

test('a spawn error rejects once and leaves no signal handlers behind', async () => {
    const { child, processRef, promise } = runStreaming();
    child.emit('error', new Error('engine is unavailable'));
    await assert.rejects(promise, /engine is unavailable/);
    assert.equal(processRef.registeredCount(), 0);
    assert.equal(child.listenerCount('error'), 0);
    assert.equal(child.listenerCount('close'), 0);
    assert.equal(child.stdin.listenerCount('error'), 0);

    // A late close after the terminal error must not settle the promise twice.
    child.emit('close', 0, null);
});

test('a race between the signal and the child close resolves exactly once', async () => {
    const { child, processRef, promise } = runStreaming();
    child.emit('close', 7, null);
    processRef.emit('SIGINT');
    child.emit('close', 0, null);
    assert.equal(await promise, 7);
    // The handlers were already gone, so the late signal never reached the child.
    assert.deepEqual(child.killed, []);
});

test('ignored and repeated operator signals escalate to a bounded SIGKILL', async () => {
    const timers = fakeTimers();
    const child = fakeChild();
    const processRef = fakeProcess();
    const promise = executeProcessStreaming('podman', ['container', 'exec'], {
        processRef,
        spawnImpl: () => child,
        ...timers,
    });
    processRef.emit('SIGTERM');
    assert.equal(child.stdin.ended, 1);
    assert.deepEqual(child.killed, ['SIGTERM']);
    processRef.emit('SIGINT');
    assert.deepEqual(child.killed, ['SIGTERM', 'SIGKILL']);
    child.emit('close', null, 'SIGKILL');
    assert.equal(await promise, 143, 'the first operator signal owns the exit code');
    assert.equal(processRef.registeredCount(), 0);

    const stuckTimers = fakeTimers();
    const stuckChild = fakeChild();
    const stuckProcess = fakeProcess();
    const stuck = executeProcessStreaming('podman', ['container', 'exec'], {
        processRef: stuckProcess,
        spawnImpl: () => stuckChild,
        ...stuckTimers,
    });
    stuckProcess.emit('SIGINT');
    stuckTimers.runNext();
    stuckTimers.runNext();
    await assert.rejects(stuck, (error) => error.code === 'PLOINKY_BOX_STREAM_CLEANUP_FAILED');
    assert.equal(stuckChild.unrefCount, 1);
    assert.equal(stuckProcess.registeredCount(), 0);
    assert.equal(stuckChild.listenerCount('error'), 0);
    assert.equal(stuckChild.listenerCount('close'), 0);
    assert.equal(stuckChild.stdin.listenerCount('error'), 0);
});

test('a child error after operator cancellation cannot bypass bounded cleanup', async () => {
    const timers = fakeTimers();
    const child = fakeChild();
    const processRef = fakeProcess();
    const promise = executeProcessStreaming('podman', ['container', 'exec'], {
        processRef,
        spawnImpl: () => child,
        ...timers,
    });

    processRef.emit('SIGINT');
    child.emit('error', new Error('signal delivery raced with child shutdown'));
    let settled = false;
    promise.finally(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'post-cancel errors must leave escalation supervision active');

    timers.runNext();
    assert.deepEqual(child.killed, ['SIGINT', 'SIGKILL']);
    child.emit('close', null, 'SIGKILL');
    assert.equal(await promise, 130);
    assert.equal(processRef.registeredCount(), 0);
    assert.equal(child.listenerCount('error'), 0);
    assert.equal(child.listenerCount('close'), 0);
    assert.equal(child.stdin.listenerCount('error'), 0);
});

test('a synchronous close during signal delivery schedules no orphaned timer', async () => {
    const child = fakeChild();
    const processRef = fakeProcess();
    child.kill = (signal) => {
        child.killed.push(signal);
        child.emit('close', null, signal);
        return true;
    };
    const promise = executeProcessStreaming('podman', ['container', 'exec'], {
        processRef,
        spawnImpl: () => child,
        setTimeoutImpl: () => { throw new Error('must not schedule after close'); },
    });
    processRef.emit('SIGTERM');
    assert.equal(await promise, 143);
    assert.deepEqual(child.killed, ['SIGTERM']);
});
