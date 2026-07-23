import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    beginTaskContinuation,
    ingestTaskEvent,
    listTasks,
    readTaskLog,
    hasOngoingTask,
    __testables,
} from '../../cli/server/webchat/taskStore.js';
import {
    hasRuntimeBackgroundTasks,
    routeWorkspaceRuntimeOutput,
} from '../../cli/server/handlers/webchat/runtimeState.js';

function workspace() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-tasks-'));
}

function event(overrides = {}, log = null) {
    return {
        task: {
            id: 'task_1234567890abcdef12345678',
            targetAgent: 'opencodeAgent',
            remoteTaskId: 'remote-1',
            toolName: 'execute-task',
            description: 'Build project',
            status: 'ongoing',
            remoteStatus: 'running',
            createdAt: '2026-07-14T10:00:00.000Z',
            updatedAt: '2026-07-14T10:00:00.000Z',
            error: '',
            ...overrides,
        },
        ...(log ? { log } : {}),
    };
}

test('task journal contains metadata while logs remain separate', () => {
    const root = workspace();
    ingestTaskEvent(root, event({}, { tail: 'first\n', seq: 1 }));
    ingestTaskEvent(root, event({ updatedAt: '2026-07-14T10:00:05.000Z' }, { tail: 'first\nsecond\n', seq: 2 }));
    const journal = fs.readFileSync(path.join(root, '.copilot_history', 'agent_tasks'), 'utf8');
    assert.doesNotMatch(journal, /first|second/);
    assert.equal(listTasks(root).length, 1);
    assert.equal(readTaskLog(root, 'task_1234567890abcdef12345678').text, 'first\nsecond\n');
});

test('terminal task state cannot regress to ongoing', () => {
    const root = workspace();
    ingestTaskEvent(root, event({ status: 'finished', remoteStatus: 'completed' }));
    ingestTaskEvent(root, event({ status: 'ongoing', remoteStatus: 'running' }));
    assert.equal(listTasks(root)[0].status, 'finished');
    assert.equal(hasOngoingTask(root, ['task_1234567890abcdef12345678']), false);
});

test('log snapshots append only their new suffix', () => {
    assert.equal(__testables.overlapDelta('one\ntwo\n', 'one\ntwo\nthree\n'), 'three\n');
    assert.match(__testables.overlapDelta('old', 'new'), /source truncated/);
});

test('task storage preserves raw stream and runner prefixes for UI-only formatting', () => {
    const root = workspace();
    const raw = '[opencode stdout] result\n[opencode stderr] warning\n[opencodeAgent/execute-task] exit code=0\n';
    ingestTaskEvent(root, event({}, { tail: raw, seq: 1 }));
    assert.equal(readTaskLog(root, event().task.id).text, raw);
});

test('terminal result payload is never appended to the live log', () => {
    const root = workspace();
    const taskId = event().task.id;
    const tail = 'Final assistant answer\n';
    ingestTaskEvent(root, event({ status: 'finished', remoteStatus: 'completed' }, {
        tail,
        seq: 3,
        result: 'A different terminal result that must be ignored',
    }));

    const stored = readTaskLog(root, taskId).text;
    assert.equal(stored, tail);
    assert.doesNotMatch(stored, /\[task result\]/);
    assert.doesNotMatch(stored, /different terminal result/);
    assert.equal(stored.match(/Final assistant answer/g)?.length, 1);
});

test('terminal final output is located in the existing log without being duplicated', () => {
    const root = workspace();
    const taskId = event().task.id;
    const tail = 'Read package.json\nRan tests\nFinal assistant answer\n';
    const update = ingestTaskEvent(root, {
        ...event({ status: 'finished', remoteStatus: 'completed' }, {
            tail,
            seq: 3,
        }),
        finalOutput: 'Final assistant answer\n',
    });

    assert.equal(update.task.finalOutputOffset, tail.indexOf('Final assistant answer'));
    assert.equal(update.task.finalOutputLength, 'Final assistant answer\n'.length);
    assert.equal(readTaskLog(root, taskId).text, tail);
    const journal = fs.readFileSync(path.join(root, '.copilot_history', 'agent_tasks'), 'utf8');
    assert.doesNotMatch(journal, /Final assistant answer/);
});

test('task log is capped at one MiB', () => {
    const root = workspace();
    for (let index = 0; index < 6; index += 1) {
        const character = String.fromCharCode(65 + index);
        ingestTaskEvent(root, event({}, { tail: character.repeat(256 * 1024), seq: index + 1 }));
    }
    const logPath = path.join(root, '.copilot_history', 'task_logs', 'task_1234567890abcdef12345678.log');
    assert.ok(fs.statSync(logPath).size <= __testables.MAX_LOG_BYTES);
});

test('full-retention task logs are not capped at one MiB', () => {
    const root = workspace();
    const content = 'x'.repeat(__testables.MAX_LOG_BYTES + 4096);
    ingestTaskEvent(root, event({ logRetention: 'full' }, {
        tail: content,
        seq: 1,
    }));
    assert.equal(readTaskLog(root, event().task.id).text.length, content.length);
});

test('continuation keeps the local task id and advances only its turn', () => {
    const root = workspace();
    const taskId = event().task.id;
    const continuation = {
        version: 1,
        targetAgent: 'opencodeAgent',
        toolName: 'continue-task',
        handle: '12345678-1234-4123-8123-123456789abc',
    };
    ingestTaskEvent(root, event({
        status: 'finished',
        remoteStatus: 'completed',
        continuation,
        logRetention: 'full',
    }, {
        tail: 'first answer\n',
        seq: 1,
        sourceId: 'remote-1',
    }));

    const next = beginTaskContinuation(root, taskId, {
        remoteTaskId: 'remote-2',
        message: 'Continue with tests',
        updatedAt: '2026-07-14T10:05:00.000Z',
    });

    assert.equal(next.id, taskId);
    assert.equal(next.turn, 2);
    assert.equal(next.remoteTaskId, 'remote-2');
    assert.equal(next.status, 'ongoing');
    assert.equal(next.finalOutputOffset, null);
    assert.equal(next.finalOutputLength, 0);
    assert.equal(listTasks(root).length, 1);
    assert.match(readTaskLog(root, taskId).text, /first answer[\s\S]*Continuation 2[\s\S]*Continue with tests/);

    ingestTaskEvent(root, event({
        status: 'finished',
        remoteStatus: 'completed',
        continuation,
        turn: 1,
        remoteTaskId: 'remote-1',
    }));
    assert.equal(listTasks(root)[0].turn, 2, 'late events from the previous turn are ignored');
    assert.equal(listTasks(root)[0].remoteTaskId, 'remote-2');
});

test('failed task with a provider session can start another turn', () => {
    const root = workspace();
    const taskId = event().task.id;
    ingestTaskEvent(root, event({
        status: 'error',
        remoteStatus: 'failed',
        error: 'insufficient credits',
        continuation: {
            version: 1,
            targetAgent: 'opencodeAgent',
            toolName: 'continue-task',
            handle: '12345678-1234-4123-8123-123456789abc',
        },
    }));

    const next = beginTaskContinuation(root, taskId, {
        remoteTaskId: 'remote-retry',
        message: 'Resume with the corrected model',
    });

    assert.equal(next.id, taskId);
    assert.equal(next.turn, 2);
    assert.equal(next.status, 'ongoing');
    assert.equal(next.error, '');
});

test('cancelled task with a provider session can start another turn', () => {
    const root = workspace();
    const taskId = event().task.id;
    ingestTaskEvent(root, event({
        status: 'stopped',
        remoteStatus: 'cancelled',
        continuation: {
            version: 1,
            targetAgent: 'opencodeAgent',
            toolName: 'continue-task',
            handle: '12345678-1234-4123-8123-123456789abc',
        },
    }));

    const next = beginTaskContinuation(root, taskId, {
        remoteTaskId: 'remote-after-stop',
        message: 'Resume from the saved session',
    });

    assert.equal(next.id, taskId);
    assert.equal(next.turn, 2);
    assert.equal(next.status, 'ongoing');
    assert.equal(next.error, '');
});

test('structured task output is persisted and broadcast without entering chat history', () => {
    const root = workspace();
    const writes = [];
    const tab = {
        workspaceDirectory: root,
        sessionId: 'session',
        backgroundTaskIds: new Set(),
        subscribers: new Map([['client', { res: { write: (value) => writes.push(value) } }]]),
    };
    const appState = { runtimes: new Map([['runtime', tab]]) };
    routeWorkspaceRuntimeOutput(appState, tab, `${JSON.stringify({ __webchatTask: 1, task: event().task })}\n`);
    assert.equal(listTasks(root).length, 1);
    assert.equal(tab.backgroundTaskIds.has(event().task.id), true);
    assert.match(writes.join(''), /event: task-update/);
    assert.equal(hasRuntimeBackgroundTasks(tab), true);
});

test('started task placement supplied by AchillesCLI is forwarded without Ploinky session writes', (t) => {
    const root = workspace();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const sessionId = '123e4567-e89b-42d3-a456-426614174000';
    const writes = [];
    const tab = {
        workspaceDirectory: root,
        backgroundTaskIds: new Set(),
        subscribers: new Map([['client', { res: { write: (value) => writes.push(value) } }]]),
    };
    const appState = { runtimes: new Map([['runtime', tab]]) };
    routeWorkspaceRuntimeOutput(appState, tab, `${JSON.stringify({
        __webchatTask: 1,
        event: 'started',
        task: event().task,
        sessionId,
        messageIndex: 2,
    })}\n`);

    const wire = writes.join('');
    assert.match(wire, new RegExp(`"sessionId":"${sessionId}"`));
    assert.match(wire, /"messageIndex":2/);
    assert.equal(fs.existsSync(path.join(root, '.achilles-cli')), false);
    assert.equal(fs.existsSync(path.join(root, '.copilot_history', `${sessionId}.json`)), false);
});
