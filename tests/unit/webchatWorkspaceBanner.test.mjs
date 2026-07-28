import assert from 'node:assert/strict';
import test from 'node:test';

import {
    logPloinkyDirectory,
    shouldLogPloinkyDirectory,
} from '../../cli/utils/config.js';
import { routeWorkspaceRuntimeOutput } from '../../cli/server/handlers/webchat/runtimeState.js';

test('workspace directory banner is hidden only for WebChat history metadata', () => {
    assert.equal(shouldLogPloinkyDirectory({}), true);
    for (const hasHistory of ['0', '1']) {
        assert.equal(shouldLogPloinkyDirectory({
            PLOINKY_WEBCHAT_HAS_HISTORY: hasHistory,
        }), false);
    }
    assert.equal(shouldLogPloinkyDirectory({ PLOINKY_WEBCHAT_HAS_HISTORY: 'yes' }), true);
});

test('normal CLI keeps the workspace directory banner', () => {
    const previousHasHistory = process.env.PLOINKY_WEBCHAT_HAS_HISTORY;
    const originalLog = console.log;
    const originalError = console.error;
    const stdoutCalls = [];
    const stderrCalls = [];
    try {
        delete process.env.PLOINKY_WEBCHAT_HAS_HISTORY;
        console.log = (...args) => stdoutCalls.push(args.join(' '));
        console.error = (...args) => stderrCalls.push(args.join(' '));
        logPloinkyDirectory();
    } finally {
        console.log = originalLog;
        console.error = originalError;
        if (previousHasHistory === undefined) delete process.env.PLOINKY_WEBCHAT_HAS_HISTORY;
        else process.env.PLOINKY_WEBCHAT_HAS_HISTORY = previousHasHistory;
    }
    assert.equal(stdoutCalls.length, 0);
    assert.equal(stderrCalls.length, 1);
    assert.match(stderrCalls[0], /^\[ploinky\] using \.ploinky:/);
});

test('WebChat suppresses nested Ploinky workspace banners and keeps adjacent output', () => {
    const writes = [];
    const tab = {
        subscribers: new Map([['client', { res: { write: (value) => writes.push(value) } }]]),
        taskProtocolBuffer: '',
    };
    const appState = { runtimes: new Map([['runtime', tab]]) };

    routeWorkspaceRuntimeOutput(
        appState,
        tab,
        '[ploinky] using .ploinky: /workspace/.ploinky\n[reinstall] complete\n',
    );

    assert.doesNotMatch(writes.join(''), /using \.ploinky/);
    assert.match(writes.join(''), /\[reinstall\] complete/);
});
