import assert from 'node:assert/strict';
import test from 'node:test';

import {
    logPloinkyDirectory,
    shouldLogPloinkyDirectory,
} from '../../cli/services/config.js';

const SESSION_ID = '12345678-1234-4123-8123-123456789abc';

test('workspace directory banner is hidden only for validated WebChat session metadata', () => {
    assert.equal(shouldLogPloinkyDirectory({}), true);
    assert.equal(shouldLogPloinkyDirectory({
        PLOINKY_WEBCHAT_SESSION_ID: '../unsafe',
        PLOINKY_WEBCHAT_HAS_HISTORY: '1',
    }), true);
    for (const hasHistory of ['0', '1']) {
        assert.equal(shouldLogPloinkyDirectory({
            PLOINKY_WEBCHAT_SESSION_ID: SESSION_ID,
            PLOINKY_WEBCHAT_HAS_HISTORY: hasHistory,
        }), false);
    }
});

test('normal CLI keeps the workspace directory banner', () => {
    const previousSessionId = process.env.PLOINKY_WEBCHAT_SESSION_ID;
    const previousHasHistory = process.env.PLOINKY_WEBCHAT_HAS_HISTORY;
    const originalLog = console.log;
    const calls = [];
    try {
        delete process.env.PLOINKY_WEBCHAT_SESSION_ID;
        delete process.env.PLOINKY_WEBCHAT_HAS_HISTORY;
        console.log = (...args) => calls.push(args.join(' '));
        logPloinkyDirectory();
    } finally {
        console.log = originalLog;
        if (previousSessionId === undefined) delete process.env.PLOINKY_WEBCHAT_SESSION_ID;
        else process.env.PLOINKY_WEBCHAT_SESSION_ID = previousSessionId;
        if (previousHasHistory === undefined) delete process.env.PLOINKY_WEBCHAT_HAS_HISTORY;
        else process.env.PLOINKY_WEBCHAT_HAS_HISTORY = previousHasHistory;
    }
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^\[ploinky\] using \.ploinky:/);
});
