import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
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
import {
    appendSessionTurn,
    appendToAssistantMessage,
    ensureCurrentSession,
    loadSession,
} from '../../cli/server/webchat/sessionStore.js';

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

test('task log is capped at one MiB', () => {
    const root = workspace();
    for (let index = 0; index < 6; index += 1) {
        const character = String.fromCharCode(65 + index);
        ingestTaskEvent(root, event({}, { tail: character.repeat(256 * 1024), seq: index + 1 }));
    }
    const logPath = path.join(root, '.copilot_history', 'task_logs', 'task_1234567890abcdef12345678.log');
    assert.ok(fs.statSync(logPath).size <= __testables.MAX_LOG_BYTES);
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

test('started tasks become separate ordered items after the active assistant placeholder', (t) => {
    const root = workspace();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const session = ensureCurrentSession(root);
    const turn = appendSessionTurn(root, session.sessionId, { text: 'Build project' });
    const writes = [];
    const tab = {
        workspaceDirectory: root,
        sessionId: session.sessionId,
        backgroundTaskIds: new Set(),
        subscribers: new Map([['client', { res: { write: (value) => writes.push(value) } }]]),
        workspaceHistory: {
            workspaceDirectory: root,
            sessionId: session.sessionId,
            lastAssistantMessageIndex: turn.assistantMessageIndex,
        },
    };
    const appState = { runtimes: new Map([['runtime', tab]]) };
    routeWorkspaceRuntimeOutput(appState, tab, `${JSON.stringify({
        __webchatTask: 1,
        event: 'started',
        task: event().task,
    })}\n`);
    const secondTaskId = 'task_abcdefabcdefabcdefabcdef';
    routeWorkspaceRuntimeOutput(appState, tab, `${JSON.stringify({
        __webchatTask: 1,
        event: 'started',
        task: event({ id: secondTaskId, remoteTaskId: 'remote-2' }).task,
    })}\n`);
    appendToAssistantMessage(root, session.sessionId, turn.assistantMessageIndex, 'Tasks started');

    const messages = loadSession(root, session.sessionId).messages;
    assert.equal(messages[1].text, 'Tasks started');
    assert.deepEqual(messages.slice(2), [
        { type: 'task', taskId: event().task.id },
        { type: 'task', taskId: secondTaskId },
    ]);
    const wire = writes.join('');
    assert.match(wire, new RegExp(`"sessionId":"${session.sessionId}"`));
    assert.match(wire, /"messageIndex":2/);
    assert.match(wire, /"messageIndex":3/);
});
