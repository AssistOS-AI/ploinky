import assert from 'node:assert/strict';
import test from 'node:test';

import { buildShellEnvironment } from '../../core-services/webtty/environment.mjs';
import {
    WEBTTY_PROTOCOL_LIMITS,
    WEBTTY_WORKER_PROTOCOL,
    validateRouterToWorkerMessage,
    validateWorkerToRouterMessage,
    workerMessage,
} from '../../core-services/webtty/worker-protocol.mjs';

const TERMINAL_ID = 'abcdefghijklmnopqrstuvwx';

function init(overrides = {}) {
    return workerMessage('init', TERMINAL_ID, {
        cwdRelative: 'repo/src',
        cols: 80,
        rows: 24,
        shellEnv: buildShellEnvironment(),
        ...overrides,
    });
}

test('the exact protocol accepts only ordered Router messages', () => {
    assert.equal(validateRouterToWorkerMessage(init()).type, 'init');
    assert.equal(validateRouterToWorkerMessage(
        workerMessage('input', TERMINAL_ID, { data: 'pwd\r' }),
        { initialized: true, expectedTerminalId: TERMINAL_ID },
    ).type, 'input');
    assert.equal(validateRouterToWorkerMessage(
        workerMessage('resize', TERMINAL_ID, { cols: 120, rows: 40 }),
        { initialized: true, expectedTerminalId: TERMINAL_ID },
    ).type, 'resize');
    assert.equal(validateRouterToWorkerMessage(
        workerMessage('close', TERMINAL_ID),
        { initialized: true, closing: true, expectedTerminalId: TERMINAL_ID },
    ).type, 'close');

    assert.throws(
        () => validateRouterToWorkerMessage(workerMessage('input', TERMINAL_ID, { data: 'x' })),
        (error) => error.code === 'WEBTTY_WORKER_PROTOCOL_INVALID' && error.category === 'pre-init',
    );
    assert.throws(
        () => validateRouterToWorkerMessage(init(), { initialized: true }),
        (error) => error.category === 'duplicate-init',
    );
});

test('unknown versions, types, extra fields, and correlation mismatches fail closed', () => {
    const vectors = [
        { ...init(), protocol: 'old' },
        { ...init(), type: 'spawn' },
        { ...init(), command: 'id' },
        { ...init(), terminalId: '../wrong' },
    ];
    for (const value of vectors) assert.throws(() => validateRouterToWorkerMessage(value));
    assert.throws(() => validateRouterToWorkerMessage(init(), { expectedTerminalId: 'z'.repeat(24) }));
    assert.throws(() => validateRouterToWorkerMessage({
        protocol: WEBTTY_WORKER_PROTOCOL,
        type: '__proto__',
        terminalId: TERMINAL_ID,
    }));
});

test('input, cwd, dimensions, and environment are byte-bounded', () => {
    assert.throws(() => validateRouterToWorkerMessage(init({ cols: 1 })));
    assert.throws(() => validateRouterToWorkerMessage(init({ rows: WEBTTY_PROTOCOL_LIMITS.maxRows + 1 })));
    assert.throws(() => validateRouterToWorkerMessage(init({ cwdRelative: 'x'.repeat(WEBTTY_PROTOCOL_LIMITS.maxCwdBytes + 1) })));
    assert.throws(() => validateRouterToWorkerMessage(init({ shellEnv: { ...buildShellEnvironment(), AUTH_TOKEN: '\0' } })));
    assert.throws(() => validateRouterToWorkerMessage(
        workerMessage('input', TERMINAL_ID, { data: '💥'.repeat((WEBTTY_PROTOCOL_LIMITS.maxInputBytes / 4) + 1) }),
        { initialized: true },
    ));
    assert.throws(() => validateRouterToWorkerMessage(
        workerMessage('resize', TERMINAL_ID, { cols: Number.MAX_SAFE_INTEGER, rows: -1 }),
        { initialized: true },
    ));
});

test('worker messages have strict shapes, evidence, bounds, and categories', () => {
    const identity = {
        pid: 4242,
        startToken: 'linux-proc:123456',
        processGroupId: 4242,
        sessionId: 4242,
        foregroundProcessGroupId: 4242,
        ttyNumber: 34816,
    };
    assert.equal(validateWorkerToRouterMessage(
        workerMessage('ready', TERMINAL_ID, { processIdentity: identity }),
        { expectedTerminalId: TERMINAL_ID },
    ).type, 'ready');
    assert.equal(validateWorkerToRouterMessage(
        workerMessage('output', TERMINAL_ID, { sequence: 1, data: 'ok' }),
    ).sequence, 1);
    assert.equal(validateWorkerToRouterMessage(
        workerMessage('exit', TERMINAL_ID, { exitCode: 0, signal: null, category: 'clean' }),
    ).category, 'clean');
    assert.equal(validateWorkerToRouterMessage(
        workerMessage('error', TERMINAL_ID, { category: 'native-runtime' }),
    ).category, 'native-runtime');

    assert.throws(() => validateWorkerToRouterMessage(workerMessage('ready', TERMINAL_ID, {
        processIdentity: { ...identity, pid: 0 },
    })));
    assert.throws(() => validateWorkerToRouterMessage(workerMessage('output', TERMINAL_ID, {
        sequence: 0,
        data: 'x',
    })));
    assert.throws(() => validateWorkerToRouterMessage(workerMessage('output', TERMINAL_ID, {
        sequence: 1,
        data: 'x'.repeat(WEBTTY_PROTOCOL_LIMITS.maxOutputBytes + 1),
    })));
    assert.throws(() => validateWorkerToRouterMessage(workerMessage('exit', TERMINAL_ID, {
        exitCode: 0,
        signal: null,
        category: 'secret-details',
    })));
    assert.throws(() => validateWorkerToRouterMessage(workerMessage('error', TERMINAL_ID, {
        category: 'stack: /workspace/.ploinky/.secrets',
    })));
});
