import assert from 'node:assert/strict';
import test from 'node:test';

import {
    parseTaskLog,
    taskDurationSeconds,
    taskStatusPresentation,
} from '../../cli/server/webchat/taskPresentation.js';

test('task status presentation preserves queued work and maps lifecycle labels', () => {
    assert.equal(taskStatusPresentation({ status: 'ongoing', remoteStatus: 'pending' }).label, 'QUEUED');
    assert.equal(taskStatusPresentation({ status: 'ongoing', remoteStatus: 'running' }).label, 'RUNNING');
    assert.equal(taskStatusPresentation({ status: 'finished' }).label, 'COMPLETED');
    assert.equal(taskStatusPresentation({ status: 'error' }).label, 'FAILED');
    assert.equal(taskStatusPresentation(null).label, 'UNAVAILABLE');
});

test('task duration uses the terminal update time and displays whole seconds', () => {
    assert.equal(taskDurationSeconds({
        status: 'finished',
        createdAt: '2026-07-15T10:00:00.000Z',
        updatedAt: '2026-07-15T10:00:04.900Z',
    }), 4);
});

test('task log parsing strips runner prefixes and keeps stderr visually distinct', () => {
    const parsed = parseTaskLog([
        '[opencodeAgent/execute-task] start projectDir="/work"',
        '[opencode stdout] primary output',
        '[opencode stderr] secondary output',
        '[opencodeAgent/execute-task] exit code=0 durationMs=1234',
        '[opencodeAgent/execute-task] timeout after 300s; sending SIGTERM',
    ].join('\n'));
    assert.deepEqual(parsed, [
        { text: 'primary output', stream: 'stdout' },
        { text: 'secondary output', stream: 'stderr' },
        { text: 'timeout after 300s; sending SIGTERM', stream: 'stderr' },
    ]);
});
