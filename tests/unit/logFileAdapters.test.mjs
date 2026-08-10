import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    MAX_LAST_OUTPUT_BYTES,
    READ_CHUNK_BYTES,
    buildRuntimeLogArgs,
    followDescriptor,
    openVerifiedLogFile,
    readLastLinesFromDescriptor,
    runRuntimeLogs,
    writeWithBackpressure,
} from '../../cli/commands/logUtils.js';

function workspace(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-log-adapters-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function collector() {
    const chunks = [];
    return {
        chunks,
        write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
        text() { return Buffer.concat(chunks).toString('utf8'); },
        bytes() { return Buffer.concat(chunks).length; },
    };
}

function closeAll(...opened) {
    for (const entry of opened) {
        if (entry?.descriptor !== undefined) {
            try { fs.closeSync(entry.descriptor); } catch (_) {}
        }
    }
}

test('a verified open rejects unsafe path segments before touching the filesystem', (t) => {
    const root = workspace(t);
    for (const segment of ['..', '.', '', 'a/b', 'a\0b', '/etc', '-leading']) {
        assert.throws(
            () => openVerifiedLogFile({ trustedRoot: root, relativeSegments: [segment] }),
            (error) => error.code === 'LOG_PATH_UNSAFE',
            `expected rejection for segment: ${JSON.stringify(segment)}`,
        );
    }
    assert.throws(
        () => openVerifiedLogFile({ trustedRoot: root, relativeSegments: [] }),
        (error) => error.code === 'LOG_PATH_UNSAFE',
    );
});

test('an absent root, directory, or file reports absence instead of failing', (t) => {
    const root = workspace(t);
    assert.equal(openVerifiedLogFile({
        trustedRoot: path.join(root, 'missing'),
        relativeSegments: ['router.log'],
    }), null);
    assert.equal(openVerifiedLogFile({
        trustedRoot: root,
        relativeSegments: ['no-wait', 'agent.log'],
    }), null);
    assert.equal(openVerifiedLogFile({
        trustedRoot: root,
        relativeSegments: ['router.log'],
    }), null);
});

test('a symlinked root, parent, or file is rejected', (t) => {
    const root = workspace(t);
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'router.log'), 'foreign\n');

    const linkedRoot = path.join(root, 'linked-root');
    fs.symlinkSync(outside, linkedRoot);
    assert.throws(
        () => openVerifiedLogFile({ trustedRoot: linkedRoot, relativeSegments: ['router.log'] }),
        (error) => error.code === 'LOG_PATH_UNSAFE' && /not one regular directory/.test(error.message),
    );

    const logs = path.join(root, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.symlinkSync(outside, path.join(logs, 'no-wait'));
    assert.throws(
        () => openVerifiedLogFile({ trustedRoot: logs, relativeSegments: ['no-wait', 'router.log'] }),
        (error) => error.code === 'LOG_PATH_UNSAFE' && /not one regular directory/.test(error.message),
    );

    fs.symlinkSync(path.join(outside, 'router.log'), path.join(logs, 'router.log'));
    assert.throws(
        () => openVerifiedLogFile({ trustedRoot: logs, relativeSegments: ['router.log'] }),
        (error) => error.code === 'LOG_PATH_UNSAFE' && /not one regular file/.test(error.message),
    );
});

test('a non-regular file is rejected', (t) => {
    const root = workspace(t);
    fs.mkdirSync(path.join(root, 'router.log'));
    assert.throws(
        () => openVerifiedLogFile({ trustedRoot: root, relativeSegments: ['router.log'] }),
        (error) => error.code === 'LOG_PATH_UNSAFE' && /not one regular file/.test(error.message),
    );
});

test('an inode swapped between validation and open is rejected', (t) => {
    const root = workspace(t);
    const target = path.join(root, 'router.log');
    fs.writeFileSync(target, 'original\n');
    const replacement = path.join(root, 'replacement.log');
    fs.writeFileSync(replacement, 'replacement\n');

    let lstatCalls = 0;
    const fsApi = {
        ...fs,
        constants: fs.constants,
        lstatSync: (...args) => {
            const stat = fs.lstatSync(...args);
            lstatCalls += 1;
            // Swap the pathname to a different inode after it was validated.
            if (String(args[0]) === target) fs.renameSync(replacement, target);
            return stat;
        },
    };
    assert.throws(
        () => openVerifiedLogFile({ trustedRoot: root, relativeSegments: ['router.log'], fsApi }),
        (error) => error.code === 'LOG_PATH_UNSAFE' && /replaced during validation/.test(error.message),
    );
    assert.ok(lstatCalls > 0);
});

test('a verified descriptor stays bound to its inode after the pathname is replaced', (t) => {
    const root = workspace(t);
    const target = path.join(root, 'router.log');
    fs.writeFileSync(target, 'first\nsecond\n');
    const opened = openVerifiedLogFile({ trustedRoot: root, relativeSegments: ['router.log'] });
    t.after(() => closeAll(opened));

    fs.writeFileSync(path.join(root, 'other.log'), 'foreign content\n');
    fs.renameSync(path.join(root, 'other.log'), target);

    const suffix = readLastLinesFromDescriptor(opened.descriptor, { lineCount: 10 });
    assert.equal(suffix.toString('utf8'), 'first\nsecond\n');
});

test('the last-N reader returns exactly the requested suffix', (t) => {
    const root = workspace(t);
    const target = path.join(root, 'router.log');
    const lines = Array.from({ length: 500 }, (_, index) => `line-${index}`);
    fs.writeFileSync(target, `${lines.join('\n')}\n`);
    const opened = openVerifiedLogFile({ trustedRoot: root, relativeSegments: ['router.log'] });
    t.after(() => closeAll(opened));

    for (const lineCount of [1, 5, 200, 500, 900]) {
        const suffix = readLastLinesFromDescriptor(opened.descriptor, { lineCount })
            .toString('utf8');
        const expected = lines.slice(-lineCount);
        assert.deepEqual(suffix.split('\n').filter(Boolean), expected, `lineCount=${lineCount}`);
    }
});

test('the last-N reader handles empty files and a missing final newline', (t) => {
    const root = workspace(t);
    fs.writeFileSync(path.join(root, 'empty.log'), '');
    fs.writeFileSync(path.join(root, 'partial.log'), 'one\ntwo\nthree');
    const empty = openVerifiedLogFile({ trustedRoot: root, relativeSegments: ['empty.log'] });
    const partial = openVerifiedLogFile({ trustedRoot: root, relativeSegments: ['partial.log'] });
    t.after(() => closeAll(empty, partial));

    assert.equal(readLastLinesFromDescriptor(empty.descriptor, { lineCount: 10 }).length, 0);
    assert.equal(
        readLastLinesFromDescriptor(partial.descriptor, { lineCount: 2 }).toString('utf8'),
        'two\nthree',
    );
});

test('a pinned end offset bounds the suffix even after the file grows', (t) => {
    const root = workspace(t);
    const target = path.join(root, 'router.log');
    fs.writeFileSync(target, 'one\ntwo\n');
    const opened = openVerifiedLogFile({ trustedRoot: root, relativeSegments: ['router.log'] });
    t.after(() => closeAll(opened));

    const pinned = fs.statSync(target).size;
    fs.appendFileSync(target, 'three\nfour\n');

    // Without the pin the reader would re-stat and include the new bytes, which
    // a follower would then emit a second time from its own start position.
    assert.equal(
        readLastLinesFromDescriptor(opened.descriptor, { lineCount: 10, endOffset: pinned })
            .toString('utf8'),
        'one\ntwo\n',
    );
    // An unpinned read still sees the whole file.
    assert.equal(
        readLastLinesFromDescriptor(opened.descriptor, { lineCount: 10 }).toString('utf8'),
        'one\ntwo\nthree\nfour\n',
    );
    // A zero pin yields nothing rather than falling back to the real size.
    assert.equal(
        readLastLinesFromDescriptor(opened.descriptor, { lineCount: 10, endOffset: 0 }).length,
        0,
    );
});

test('the follower emits no byte twice when a write lands during the initial suffix', async (t) => {
    const root = workspace(t);
    const target = path.join(root, 'router.log');
    fs.writeFileSync(target, 'first\n');
    const opened = openVerifiedLogFile({ trustedRoot: root, relativeSegments: ['router.log'] });
    t.after(() => closeAll(opened));

    const output = collector();
    const controller = new AbortController();
    // Append exactly once, immediately after the follower takes the stat that
    // fixes its start position. Those bytes must be delivered by the first
    // poll and never by the initial suffix as well.
    let appended = false;
    const fsApi = {
        ...fs,
        constants: fs.constants,
        fstatSync: (fd) => {
            const stat = fs.fstatSync(fd);
            if (!appended) {
                appended = true;
                fs.appendFileSync(target, 'raced\n');
            }
            return stat;
        },
    };
    await followDescriptor(opened.descriptor, {
        initialLines: 10,
        output,
        signal: controller.signal,
        fsApi,
        sleepImpl: async () => controller.abort(),
    });

    const text = output.text();
    assert.equal(text.match(/raced/g)?.length, 1, `expected exactly one 'raced' line, got: ${text}`);
    assert.equal(text.match(/first/g)?.length, 1);
    assert.equal(text, 'first\nraced\n');
});

test('the last-N reader uses fixed-size buffers regardless of file size', (t) => {
    const root = workspace(t);
    const target = path.join(root, 'router.log');
    // One line far larger than the read chunk proves the scan is chunked.
    fs.writeFileSync(target, `${'a'.repeat(READ_CHUNK_BYTES * 3)}\nlast\n`);
    const opened = openVerifiedLogFile({ trustedRoot: root, relativeSegments: ['router.log'] });
    t.after(() => closeAll(opened));

    const sizes = [];
    const fsApi = {
        ...fs,
        constants: fs.constants,
        readSync: (fd, buffer, offset, length, position) => {
            sizes.push(length);
            return fs.readSync(fd, buffer, offset, length, position);
        },
    };
    const suffix = readLastLinesFromDescriptor(opened.descriptor, { lineCount: 1, fsApi });
    assert.equal(suffix.toString('utf8'), 'last\n');
    assert.ok(sizes.length > 0);
    assert.ok(Math.max(...sizes) <= READ_CHUNK_BYTES);
});

test('one over-limit line fails the bounded last reader instead of emitting it', (t) => {
    const root = workspace(t);
    const target = path.join(root, 'router.log');
    const byteLimit = 4 * READ_CHUNK_BYTES;
    fs.writeFileSync(target, `${'x'.repeat(byteLimit * 2)}\n`);
    const opened = openVerifiedLogFile({ trustedRoot: root, relativeSegments: ['router.log'] });
    t.after(() => closeAll(opened));

    assert.throws(
        () => readLastLinesFromDescriptor(opened.descriptor, { lineCount: 5, byteLimit }),
        (error) => error.code === 'LOG_OUTPUT_LIMIT',
    );
    assert.equal(MAX_LAST_OUTPUT_BYTES, 16 * 1024 * 1024);
});

test('the last-N reader fails closed when the pinned file shrinks during a read', () => {
    const fsApi = {
        fstatSync: () => ({ size: 12 }),
        readSync: () => 0,
    };
    assert.throws(
        () => readLastLinesFromDescriptor(123, { lineCount: 5, fsApi }),
        (error) => error.code === 'LOG_PATH_UNSAFE'
            && /changed while its suffix was being read/.test(error.message),
    );
});

test('the follower emits the initial suffix then streams appended bytes', async (t) => {
    const root = workspace(t);
    const target = path.join(root, 'router.log');
    fs.writeFileSync(target, `${Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n')}\n`);
    const opened = openVerifiedLogFile({ trustedRoot: root, relativeSegments: ['router.log'] });
    t.after(() => closeAll(opened));

    const output = collector();
    const controller = new AbortController();
    let polls = 0;
    const follow = followDescriptor(opened.descriptor, {
        initialLines: 10,
        output,
        signal: controller.signal,
        sleepImpl: async () => {
            polls += 1;
            if (polls === 1) fs.appendFileSync(target, 'appended-one\n');
            if (polls === 2) fs.appendFileSync(target, 'appended-two\n');
            if (polls >= 3) controller.abort();
        },
    });
    await follow;

    const text = output.text();
    // Exactly the last ten lines open the stream, closing the handoff gap.
    assert.match(text, /^line-20\n/);
    assert.equal(text.includes('line-19'), false);
    assert.match(text, /appended-one\nappended-two\n$/);
});

test('the follower restarts cleanly when its own inode is truncated', async (t) => {
    const root = workspace(t);
    const target = path.join(root, 'router.log');
    fs.writeFileSync(target, 'before\n');
    const opened = openVerifiedLogFile({ trustedRoot: root, relativeSegments: ['router.log'] });
    t.after(() => closeAll(opened));

    const output = collector();
    const controller = new AbortController();
    let polls = 0;
    await followDescriptor(opened.descriptor, {
        initialLines: 10,
        output,
        signal: controller.signal,
        sleepImpl: async () => {
            polls += 1;
            if (polls === 1) fs.truncateSync(target, 0);
            if (polls === 2) fs.appendFileSync(target, 'after-truncate\n');
            if (polls >= 3) controller.abort();
        },
    });
    assert.match(output.text(), /before\nafter-truncate\n$/);
});

test('the follower stops promptly when its signal aborts', async (t) => {
    const root = workspace(t);
    fs.writeFileSync(path.join(root, 'router.log'), 'only\n');
    const opened = openVerifiedLogFile({ trustedRoot: root, relativeSegments: ['router.log'] });
    t.after(() => closeAll(opened));

    const controller = new AbortController();
    controller.abort();
    const output = collector();
    await followDescriptor(opened.descriptor, {
        initialLines: 10,
        output,
        signal: controller.signal,
        sleepImpl: async () => { throw new Error('an aborted follower must not sleep'); },
    });
    assert.equal(output.text(), '');
});

test('backpressured writes wait for drain and remove every temporary listener', async () => {
    const writable = new EventEmitter();
    writable.write = () => false;
    const pending = writeWithBackpressure(writable, Buffer.from('chunk'));
    assert.equal(writable.listenerCount('drain'), 1);
    assert.equal(writable.listenerCount('error'), 1);
    assert.equal(writable.listenerCount('close'), 1);
    writable.emit('drain');
    assert.equal(await pending, true);
    assert.equal(writable.eventNames().length, 0);

    const controller = new AbortController();
    const aborted = writeWithBackpressure(writable, Buffer.from('chunk'), {
        signal: controller.signal,
    });
    controller.abort();
    assert.equal(await aborted, false);
    assert.equal(writable.eventNames().length, 0);
});

test('runtime log arguments are exact and unknown runtimes are rejected before spawn', () => {
    const containerId = 'a'.repeat(64);
    assert.deepEqual(
        buildRuntimeLogArgs({ runtime: 'docker', containerId, lineCount: 200 }),
        ['logs', '--tail', '200', containerId],
    );
    assert.deepEqual(
        buildRuntimeLogArgs({ runtime: 'podman', containerId, follow: true, initialLines: 10 }),
        ['logs', '--follow', '--tail', '10', containerId],
    );
    for (const runtime of ['bwrap', 'seatbelt', 'host', '', null, 'DOCKER']) {
        assert.throws(
            () => buildRuntimeLogArgs({ runtime, containerId }),
            (error) => error.code === 'LOG_RUNTIME_UNSUPPORTED',
            `expected rejection for runtime: ${runtime}`,
        );
    }
    for (const badId of ['', 'a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(63)}z`, 'name']) {
        assert.throws(
            () => buildRuntimeLogArgs({ runtime: 'docker', containerId: badId }),
            (error) => error.code === 'LOG_RUNTIME_UNSUPPORTED',
        );
    }
});

// Plain emitters keep 'data' delivery synchronous so each test controls the
// exact interleaving of output chunks, signals, and the terminal 'close'.
function fakeRuntimeChild() {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.signals = [];
    child.unrefCount = 0;
    child.kill = (signal) => { child.signals.push(signal); return true; };
    child.unref = () => { child.unrefCount += 1; };
    return child;
}

function fakeTimers() {
    const pending = [];
    return {
        setTimeoutImpl(callback) {
            const entry = { callback, cleared: false };
            pending.push(entry);
            return entry;
        },
        clearTimeoutImpl(entry) { if (entry) entry.cleared = true; },
        runNext() {
            const entry = pending.find((candidate) => !candidate.cleared);
            assert.ok(entry, 'expected one pending timer');
            entry.cleared = true;
            entry.callback();
        },
    };
}

test('runtime logs spawn a fixed executable with an argument array and pass the exit code', async () => {
    const containerId = 'b'.repeat(64);
    const child = fakeRuntimeChild();
    const output = collector();
    const spawned = [];
    const promise = runRuntimeLogs({
        runtime: 'podman',
        containerId,
        lineCount: 42,
        output,
        errorOutput: collector(),
        spawnImpl: (command, args, options) => {
            spawned.push({ command, args, options });
            return child;
        },
    });
    child.stdout.emit('data', 'application output\n');
    child.emit('close', 3, null);
    assert.equal(await promise, 3);
    assert.equal(spawned[0].command, 'podman');
    assert.deepEqual(spawned[0].args, ['logs', '--tail', '42', containerId]);
    assert.deepEqual(spawned[0].options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(output.text(), 'application output\n');
    assert.equal(child.stdout.listenerCount('data'), 0);
    assert.equal(child.stderr.listenerCount('data'), 0);
});

test('runtime last output stops at the byte ceiling and reports a limit failure', async () => {
    const child = fakeRuntimeChild();
    const output = collector();
    const promise = runRuntimeLogs({
        runtime: 'docker',
        containerId: 'c'.repeat(64),
        byteLimit: 1024,
        output,
        errorOutput: collector(),
        spawnImpl: () => child,
    });
    child.stdout.emit('data', Buffer.alloc(600, 0x61));
    child.stdout.emit('data', Buffer.alloc(600, 0x62));
    child.emit('close', 0, null);
    await assert.rejects(promise, (error) => error.code === 'LOG_OUTPUT_LIMIT');
    // The chunk that would cross the ceiling is never written.
    assert.equal(output.bytes(), 600);
    assert.deepEqual(child.signals, ['SIGTERM']);
});

test('an output limit releases an already backpressured runtime write', async () => {
    const child = fakeRuntimeChild();
    const output = new EventEmitter();
    output.write = () => false;
    const promise = runRuntimeLogs({
        runtime: 'docker',
        containerId: '9'.repeat(64),
        byteLimit: 10,
        output,
        errorOutput: collector(),
        spawnImpl: () => child,
    });

    child.stdout.emit('data', Buffer.alloc(6, 0x61));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(output.listenerCount('drain'), 1);
    child.stdout.emit('data', Buffer.alloc(6, 0x62));
    child.emit('close', 0, null);

    await assert.rejects(promise, (error) => error.code === 'LOG_OUTPUT_LIMIT');
    assert.equal(output.eventNames().length, 0);
    assert.equal(child.stdout.listenerCount('data'), 0);
    assert.equal(child.stderr.listenerCount('data'), 0);
});

test('a runtime follower is cancellable and a spawn error rejects once', async () => {
    const controller = new AbortController();
    const child = fakeRuntimeChild();
    const promise = runRuntimeLogs({
        runtime: 'docker',
        containerId: 'd'.repeat(64),
        follow: true,
        signal: controller.signal,
        output: collector(),
        errorOutput: collector(),
        spawnImpl: () => child,
    });
    controller.abort();
    assert.deepEqual(child.signals, ['SIGTERM']);
    child.emit('close', null, 'SIGTERM');
    assert.equal(await promise, 0);

    const failing = fakeRuntimeChild();
    const rejected = runRuntimeLogs({
        runtime: 'docker',
        containerId: 'e'.repeat(64),
        output: collector(),
        errorOutput: collector(),
        spawnImpl: () => failing,
    });
    failing.emit('error', new Error('engine is unavailable'));
    await assert.rejects(rejected, /engine is unavailable/);
    failing.emit('close', 0, null);
});

test('runtime output pauses until a backpressured destination drains', async () => {
    const child = fakeRuntimeChild();
    child.stdout.pauseCount = 0;
    child.stdout.resumeCount = 0;
    child.stdout.pause = () => { child.stdout.pauseCount += 1; };
    child.stdout.resume = () => { child.stdout.resumeCount += 1; };
    const output = new EventEmitter();
    output.write = () => false;
    const promise = runRuntimeLogs({
        runtime: 'docker',
        containerId: 'f'.repeat(64),
        output,
        errorOutput: collector(),
        spawnImpl: () => child,
    });
    child.stdout.emit('data', Buffer.from('slow output\n'));
    child.emit('close', 0, null);
    assert.equal(child.stdout.pauseCount, 1);
    let settled = false;
    promise.finally(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    output.emit('drain');
    assert.equal(await promise, 0);
    assert.equal(child.stdout.resumeCount, 1);
});

test('runtime cancellation escalates TERM to KILL and never waits forever', async () => {
    const controller = new AbortController();
    const child = fakeRuntimeChild();
    const timers = fakeTimers();
    const promise = runRuntimeLogs({
        runtime: 'docker',
        containerId: '1'.repeat(64),
        follow: true,
        signal: controller.signal,
        output: collector(),
        errorOutput: collector(),
        spawnImpl: () => child,
        ...timers,
    });
    controller.abort();
    assert.deepEqual(child.signals, ['SIGTERM']);
    timers.runNext();
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
    child.emit('close', null, 'SIGKILL');
    assert.equal(await promise, 0);

    const stuckController = new AbortController();
    const stuckChild = fakeRuntimeChild();
    const stuckTimers = fakeTimers();
    const stuck = runRuntimeLogs({
        runtime: 'podman',
        containerId: '2'.repeat(64),
        follow: true,
        signal: stuckController.signal,
        output: collector(),
        errorOutput: collector(),
        spawnImpl: () => stuckChild,
        ...stuckTimers,
    });
    stuckController.abort();
    stuckTimers.runNext();
    stuckTimers.runNext();
    await assert.rejects(stuck, (error) => error.code === 'LOG_CHILD_CLEANUP_FAILED');
    assert.equal(stuckChild.unrefCount, 1, 'a non-closing child must be detached after its pipes are destroyed');
    assert.equal(stuckChild.stdout.listenerCount('data'), 0);
    assert.equal(stuckChild.stderr.listenerCount('data'), 0);
});

test('a runtime child error after cancellation cannot bypass bounded cleanup', async () => {
    const controller = new AbortController();
    const child = fakeRuntimeChild();
    const timers = fakeTimers();
    const promise = runRuntimeLogs({
        runtime: 'docker',
        containerId: '3'.repeat(64),
        follow: true,
        signal: controller.signal,
        output: collector(),
        errorOutput: collector(),
        spawnImpl: () => child,
        ...timers,
    });

    controller.abort();
    child.emit('error', new Error('signal delivery raced with child shutdown'));
    let settled = false;
    promise.finally(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'post-cancel errors must leave escalation supervision active');

    timers.runNext();
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
    child.emit('close', null, 'SIGKILL');
    assert.equal(await promise, 0);
    assert.equal(child.listenerCount('error'), 0);
    assert.equal(child.listenerCount('close'), 0);
});

test('a synchronous runtime close during cancellation schedules no orphaned timer', async () => {
    const controller = new AbortController();
    const child = fakeRuntimeChild();
    child.kill = (signal) => {
        child.signals.push(signal);
        child.emit('close', null, signal);
        return true;
    };
    const promise = runRuntimeLogs({
        runtime: 'podman',
        containerId: '4'.repeat(64),
        follow: true,
        signal: controller.signal,
        output: collector(),
        errorOutput: collector(),
        spawnImpl: () => child,
        setTimeoutImpl: () => { throw new Error('must not schedule after close'); },
    });
    controller.abort();
    assert.equal(await promise, 0);
    assert.deepEqual(child.signals, ['SIGTERM']);
});
