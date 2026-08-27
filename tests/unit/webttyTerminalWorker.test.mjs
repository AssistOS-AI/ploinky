import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { buildShellEnvironment } from '../../core-services/webtty/environment.mjs';
import { TerminalWorker } from '../../core-services/webtty/terminal-worker.mjs';
import { WEBTTY_PROTOCOL_LIMITS, workerMessage } from '../../core-services/webtty/worker-protocol.mjs';

const TERMINAL_ID = 'abcdefghijklmnopqrstuvwx';
const PTY_IDENTITY = Object.freeze({
    pid: 4242,
    startToken: 'linux-proc:123456',
    processGroupId: 4242,
    sessionId: 4242,
    foregroundProcessGroupId: 4242,
    ttyNumber: 34816,
});

class FakeProcess extends EventEmitter {
    constructor() {
        super();
        this.connected = true;
        this.sent = [];
        this.exitCode = null;
        this.exits = [];
    }

    send(message, callback) {
        this.sent.push(message);
        callback?.(null);
        return true;
    }

    disconnect() {
        this.connected = false;
    }

    exit(code) {
        this.exits.push(code);
    }
}

function fakePty() {
    const state = {
        pid: 4242,
        writes: [],
        resizes: [],
        disposed: 0,
        dataHandler: null,
        exitHandler: null,
    };
    return {
        state,
        api: {
            pid: state.pid,
            onData(handler) { state.dataHandler = handler; },
            onExit(handler) { state.exitHandler = handler; },
            write(data) { state.writes.push(data); },
            resize(cols, rows) { state.resizes.push([cols, rows]); },
            dispose() { state.disposed += 1; },
        },
    };
}

function init(overrides = {}) {
    return workerMessage('init', TERMINAL_ID, {
        cwdRelative: 'repo/src',
        cols: 80,
        rows: 24,
        shellEnv: buildShellEnvironment(),
        ...overrides,
    });
}

function harness(overrides = {}) {
    const processApi = new FakeProcess();
    const terminal = fakePty();
    const spawnCalls = [];
    const signals = [];
    const worker = new TerminalWorker({
        processApi,
        resolveDirectory: overrides.resolveDirectory || ((relative) => ({
            relativePath: relative,
            absolutePath: '/workspace/repo/src',
            workspaceRealPath: '/workspace',
        })),
        loadNodePty: overrides.loadNodePty || (() => ({
            spawn(shell, args, options) {
                spawnCalls.push({ shell, args, options });
                return terminal.api;
            },
        })),
        capturePtyIdentityImpl: overrides.capturePtyIdentityImpl || (() => PTY_IDENTITY),
        signalGroupImpl: overrides.signalGroupImpl || ((identity, signal) => signals.push([identity, signal])),
        waitForExitImpl: overrides.waitForExitImpl || (async () => true),
        delayImpl: async () => {},
        identityWaitMs: overrides.identityWaitMs ?? 0,
    });
    return { worker, processApi, terminal, spawnCalls, signals };
}

test('one init creates one fixed bash PTY after cwd revalidation and reports evidence', async () => {
    const h = harness();
    await h.worker.initialize(init());
    assert.equal(h.spawnCalls.length, 1);
    assert.deepEqual(h.spawnCalls[0], {
        shell: '/bin/bash',
        args: ['--noprofile', '--norc'],
        options: {
            name: 'xterm-256color',
            cols: 80,
            rows: 24,
            cwd: '/workspace/repo/src',
            env: buildShellEnvironment(),
        },
    });
    assert.deepEqual(h.processApi.sent[0], workerMessage('ready', TERMINAL_ID, {
        processIdentity: PTY_IDENTITY,
    }));

    h.worker.handleMessage(workerMessage('input', TERMINAL_ID, { data: 'pwd\r' }));
    h.worker.handleMessage(workerMessage('resize', TERMINAL_ID, { cols: 120, rows: 40 }));
    assert.deepEqual(h.terminal.state.writes, ['pwd\r']);
    assert.deepEqual(h.terminal.state.resizes, [[120, 40]]);
});

test('output is UTF-8 byte chunked, sequenced, and never precedes ready', async () => {
    const h = harness();
    await h.worker.initialize(init());
    const data = '💥'.repeat((WEBTTY_PROTOCOL_LIMITS.maxOutputBytes / 4) + 100);
    h.terminal.state.dataHandler(data);
    const outputs = h.processApi.sent.filter((message) => message.type === 'output');
    assert.equal(outputs.length, 2);
    assert.deepEqual(outputs.map((message) => message.sequence), [1, 2]);
    assert.equal(outputs.map((message) => message.data).join(''), data);
    assert.ok(outputs.every((message) => Buffer.byteLength(message.data) <= WEBTTY_PROTOCOL_LIMITS.maxOutputBytes));
    assert.equal(h.processApi.sent[0].type, 'ready');
});

test('close and parent IPC EOF use verified TERM cleanup and exact-once exit', async () => {
    for (const category of ['requested', 'parent-disconnect']) {
        const h = harness();
        await h.worker.initialize(init());
        await h.worker.cleanup(category);
        assert.deepEqual(h.signals, [[PTY_IDENTITY, 'SIGTERM']]);
        assert.equal(h.terminal.state.disposed, 0);
        const exits = h.processApi.sent.filter((message) => message.type === 'exit');
        assert.equal(exits.length, 1);
        assert.equal(exits[0].category, category);
        assert.equal(h.processApi.connected, false);
    }
});

test('force cleanup revalidates again before SIGKILL', async () => {
    let waits = 0;
    const h = harness({ waitForExitImpl: async () => (++waits === 1 ? false : true) });
    await h.worker.initialize(init());
    await h.worker.cleanup('requested');
    assert.deepEqual(h.signals, [
        [PTY_IDENTITY, 'SIGTERM'],
        [PTY_IDENTITY, 'SIGKILL'],
    ]);
    assert.equal(h.terminal.state.disposed, 0);
});

test('cleanup reports unproven when the process remains after TERM and KILL waits', async () => {
    const h = harness({ waitForExitImpl: async () => false });
    await h.worker.initialize(init());
    await h.worker.cleanup('requested');
    assert.deepEqual(h.signals, [
        [PTY_IDENTITY, 'SIGTERM'],
        [PTY_IDENTITY, 'SIGKILL'],
    ]);
    assert.equal(h.terminal.state.disposed, 0);
    const cleanupErrorIndex = h.processApi.sent.findIndex(
        (message) => message.type === 'error' && message.category === 'cleanup-unproven',
    );
    const exitIndex = h.processApi.sent.findIndex((message) => message.type === 'exit');
    assert.ok(cleanupErrorIndex >= 0);
    assert.ok(cleanupErrorIndex < exitIndex, 'Router must receive ambiguity before the worker exit');
});

test('cleanup revalidation ambiguity emits cleanup-unproven and never force-signals', async () => {
    const signals = [];
    const h = harness({
        signalGroupImpl: (identity, signal) => {
            signals.push([identity, signal]);
            const error = new Error('identity changed');
            error.code = 'WEBTTY_PROCESS_IDENTITY_UNPROVEN';
            throw error;
        },
    });
    await h.worker.initialize(init());
    await h.worker.cleanup('requested');
    assert.equal(signals.length, 1);
    assert.equal(h.terminal.state.disposed, 0);
    assert.equal(
        h.processApi.sent.filter((message) => message.type === 'error' && message.category === 'cleanup-unproven').length,
        1,
    );
});

test('stale identity proves the original process gone without invoking native dispose', async () => {
    let signalAttempts = 0;
    const h = harness({
        signalGroupImpl: () => {
            signalAttempts += 1;
            const error = new Error('original process gone or pid reused');
            error.code = 'WEBTTY_PROCESS_IDENTITY_STALE';
            throw error;
        },
    });
    await h.worker.initialize(init());
    await h.worker.cleanup('requested');
    assert.equal(signalAttempts, 1);
    assert.equal(h.terminal.state.disposed, 0);
    assert.equal(
        h.processApi.sent.some((message) => message.type === 'error' && message.category === 'cleanup-unproven'),
        false,
    );
    assert.equal(h.processApi.sent.find((message) => message.type === 'exit')?.category, 'requested');
});

test('ambiguous identity never calls a native PID kill helper and reports unproven cleanup', async () => {
    const h = harness({
        capturePtyIdentityImpl: () => {
            const error = new Error('unproven');
            error.code = 'WEBTTY_PROCESS_IDENTITY_UNPROVEN';
            throw error;
        },
    });
    await h.worker.initialize(init());
    assert.equal(h.terminal.state.disposed, 0);
    assert.equal(h.signals.length, 0);
    assert.equal(
        h.processApi.sent.filter((message) => message.type === 'error' && message.category === 'cleanup-unproven').length,
        1,
    );
});

test('cwd and environment failures happen before loading native bytes', async () => {
    let nativeLoads = 0;
    const h = harness({
        resolveDirectory: () => {
            const error = new Error('replaced');
            error.code = 'WEBTTY_CWD_INVALID';
            throw error;
        },
        loadNodePty: () => { nativeLoads += 1; throw new Error('must not load'); },
    });
    await h.worker.initialize(init());
    assert.equal(nativeLoads, 0);
    assert.equal(h.spawnCalls.length, 0);
    assert.ok(h.processApi.sent.some((message) => message.type === 'error' && message.category === 'cwd-validation'));

    const altered = harness();
    await assert.rejects(() => altered.worker.initialize(init({
        shellEnv: { ...buildShellEnvironment(), ROUTER_SECRET: 'secret' },
    })));
    assert.equal(altered.spawnCalls.length, 0);
});

test('normal native exit reports once and disposes without group signaling', async () => {
    const h = harness();
    await h.worker.initialize(init());
    h.terminal.state.exitHandler({ exitCode: 7, signal: 0 });
    await h.worker.cleanupPromise;
    assert.equal(h.signals.length, 0);
    assert.equal(h.terminal.state.disposed, 1);
    assert.deepEqual(h.processApi.sent.filter((message) => message.type === 'exit'), [
        workerMessage('exit', TERMINAL_ID, { exitCode: 7, signal: 0, category: 'clean' }),
    ]);
});
