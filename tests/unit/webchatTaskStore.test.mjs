import assert from 'node:assert/strict';
import test from 'node:test';

import {
    hasRuntimeBackgroundTasks,
    parseWebchatTaskState,
} from '../../cli/server/handlers/webchat/runtimeState.js';

const task = {
    id: 'task_1234567890abcdef12345678',
    targetAgent: 'codexAgent',
    remoteTaskId: 'remote-1',
    toolName: 'execute-task',
    description: 'Build project',
    status: 'ongoing',
    remoteStatus: 'queued',
    createdAt: '2026-07-23T10:00:00.000Z',
    updatedAt: '2026-07-23T10:00:00.000Z',
};

test('WebChat validates AchillesCLI task lists without owning task storage', () => {
    const parsed = parseWebchatTaskState({
        __webchatTask: 1,
        version: 1,
        event: 'list',
        tasks: [{ ...task, credential: 'must-not-reach-browser', arguments: { prompt: 'secret' } }],
    });
    assert.equal(parsed.tasks[0].status, 'ongoing');
    assert.equal(parsed.tasks[0].remoteStatus, 'queued');
    assert.equal('credential' in parsed.tasks[0], false);
    assert.equal('arguments' in parsed.tasks[0], false);
});

test('WebChat validates task view snapshots and live log deltas', () => {
    const view = parseWebchatTaskState({
        __webchatTask: 1,
        version: 1,
        event: 'view',
        task,
        log: { text: 'full log', nextOffset: 8 },
    });
    assert.deepEqual(view.log, { text: 'full log', nextOffset: 8, reset: false });

    const update = parseWebchatTaskState({
        __webchatTask: 1,
        version: 1,
        event: 'update',
        task: { ...task, remoteStatus: 'running' },
        logAppend: 'next',
        logOffset: 12,
    });
    assert.equal(update.logAppend, 'next');
    assert.equal(update.logOffset, 12);

    const continued = parseWebchatTaskState({
        __webchatTask: 1,
        version: 1,
        event: 'continued',
        task: { ...task, remoteTaskId: 'remote-2', turn: 2 },
        logAppend: '\n[Continuation 2]\nUser: finish the tests\n\n',
        logOffset: 58,
    });
    assert.equal(continued.event, 'continued');
    assert.match(continued.logAppend, /User: finish the tests/);
    assert.equal(continued.logOffset, 58);
});

test('runtime cleanup uses only volatile AchillesCLI task state', () => {
    const tab = { webchatTasks: new Map([[task.id, task]]) };
    assert.equal(hasRuntimeBackgroundTasks(tab), true);
    tab.webchatTasks.set(task.id, { ...task, status: 'finished', remoteStatus: 'completed' });
    assert.equal(hasRuntimeBackgroundTasks(tab), false);
});
