import assert from 'node:assert/strict';
import test from 'node:test';

import {
    logPloinkyDirectory,
    shouldLogPloinkyDirectory,
} from '../../cli/services/config.js';

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
    const calls = [];
    try {
        delete process.env.PLOINKY_WEBCHAT_HAS_HISTORY;
        console.log = (...args) => calls.push(args.join(' '));
        logPloinkyDirectory();
    } finally {
        console.log = originalLog;
        if (previousHasHistory === undefined) delete process.env.PLOINKY_WEBCHAT_HAS_HISTORY;
        else process.env.PLOINKY_WEBCHAT_HAS_HISTORY = previousHasHistory;
    }
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^\[ploinky\] using \.ploinky:/);
});
