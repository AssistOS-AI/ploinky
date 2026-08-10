import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { cleanupWhenResponseCloses } from '../../cli/server/streamLifecycle.js';

test('stream cleanup follows the response lifecycle, not request completion', () => {
    const request = new EventEmitter();
    const response = new EventEmitter();
    let calls = 0;
    cleanupWhenResponseCloses(response, () => { calls += 1; });

    request.emit('close');
    assert.equal(calls, 0);
    response.emit('close');
    response.emit('close');
    assert.equal(calls, 1);
});
