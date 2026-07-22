import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    appendAssistantProgress,
    appendSessionMessage,
    appendSessionTurn,
    appendToAssistantMessage,
    buildContinuationHistory,
    createSession,
    ensureCurrentSession,
    formatContinuationContext,
    insertSessionTaskItem,
    listSessions,
    loadSession,
    selectSession,
} from '../../cli/server/webchat/sessionStore.js';

function makeWorkspace(t) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-webchat-history-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    return workspace;
}

test('creates one current folder session and reuses it', (t) => {
    const workspace = makeWorkspace(t);
    const first = ensureCurrentSession(workspace);
    const second = ensureCurrentSession(workspace);

    assert.equal(second.sessionId, first.sessionId);
    assert.deepEqual(Object.keys(first).sort(), ['createdAt', 'messages', 'sessionId', 'updatedAt']);
    assert.equal(fs.existsSync(path.join(workspace, '.copilot_history', `${first.sessionId}.json`)), true);
    assert.equal(fs.readFileSync(path.join(workspace, '.copilot_history', '.gitignore'), 'utf8'), '*\n!.gitignore\n');
    assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(workspace, '.copilot_history', 'current_session.json'), 'utf8')),
        { sessionId: first.sessionId }
    );
});

test('lists session selector metadata without message count or content', (t) => {
    const workspace = makeWorkspace(t);
    const first = ensureCurrentSession(workspace);
    appendSessionMessage(workspace, first.sessionId, { role: 'user', text: '  A first   prompt  ' });
    const second = createSession(workspace);

    const listed = listSessions(workspace);
    assert.equal(listed.currentSessionId, second.sessionId);
    assert.equal(listed.sessions.length, 2);
    const firstSummary = listed.sessions.find((entry) => entry.sessionId === first.sessionId);
    assert.equal(firstSummary.preview, 'A first prompt');
    assert.equal(Object.hasOwn(firstSummary, 'messageCount'), false);
    assert.equal(Object.hasOwn(firstSummary, 'messages'), false);
});

test('selects an existing session and appends ordered messages', (t) => {
    const workspace = makeWorkspace(t);
    const first = ensureCurrentSession(workspace);
    const second = createSession(workspace);
    selectSession(workspace, first.sessionId);

    const user = appendSessionMessage(workspace, first.sessionId, {
        role: 'user',
        text: 'Hello',
        references: [{ kind: 'workspace-path', path: 'README.md' }]
    });
    const assistant = appendSessionMessage(workspace, first.sessionId, { role: 'assistant', text: 'Hi' });
    appendToAssistantMessage(workspace, first.sessionId, assistant.messageIndex, 'How can I help?');

    const loaded = loadSession(workspace, first.sessionId);
    assert.equal(ensureCurrentSession(workspace).sessionId, first.sessionId);
    assert.equal(user.messageIndex, 0);
    assert.deepEqual(loaded.messages.map((entry) => entry.role), ['user', 'assistant']);
    assert.equal(loaded.messages[1].text, 'Hi\nHow can I help?');
    assert.equal(loaded.messages[0].references[0].path, 'README.md');
    assert.deepEqual(Object.keys(loaded.messages[0]).sort(), [
        'attachments',
        'references',
        'role',
        'text',
        'timestamp'
    ]);
    assert.notEqual(second.sessionId, first.sessionId);
});

test('persists an assistant placeholder and ordered progress in the same turn', (t) => {
    const workspace = makeWorkspace(t);
    const session = ensureCurrentSession(workspace);
    const turn = appendSessionTurn(workspace, session.sessionId, {
        text: 'Inspect the repository',
        references: [{ kind: 'workspace-path', path: 'README.md' }]
    });

    assert.equal(turn.userMessageIndex, 0);
    assert.equal(turn.assistantMessageIndex, 1);
    assert.equal(turn.assistantMessage.text, '');
    assert.deepEqual(turn.assistantMessage.progress, []);

    appendAssistantProgress(workspace, session.sessionId, turn.assistantMessageIndex, '  Reading files  ');
    appendAssistantProgress(workspace, session.sessionId, turn.assistantMessageIndex, 'Comparing changes');
    appendToAssistantMessage(workspace, session.sessionId, turn.assistantMessageIndex, 'Inspection complete');

    const loaded = loadSession(workspace, session.sessionId);
    assert.equal(loaded.messages.length, 2);
    assert.equal(loaded.messages[1].text, 'Inspection complete');
    assert.deepEqual(loaded.messages[1].progress, ['Reading files', 'Comparing changes']);
    assert.equal(Object.hasOwn(loaded.messages[0], 'progress'), false);
});

test('normalizes optional assistant progress without changing legacy messages', (t) => {
    const workspace = makeWorkspace(t);
    const session = ensureCurrentSession(workspace);
    const sessionPath = path.join(workspace, '.copilot_history', `${session.sessionId}.json`);
    const record = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    const timestamp = new Date().toISOString();
    record.messages = [
        { role: 'assistant', text: 'Legacy', timestamp, attachments: [], references: [] },
        {
            role: 'assistant',
            text: 'Current',
            timestamp,
            attachments: [],
            references: [],
            progress: ['  first  ', '', 17, 'second']
        },
        { role: 'assistant', text: '', timestamp, attachments: [], references: [], progress: ['UI only'] }
    ];
    fs.writeFileSync(sessionPath, `${JSON.stringify(record, null, 2)}\n`);

    const loaded = loadSession(workspace, session.sessionId);
    assert.equal(Object.hasOwn(loaded.messages[0], 'progress'), false);
    assert.deepEqual(loaded.messages[1].progress, ['first', 'second']);
    const context = formatContinuationContext(loaded);
    assert.doesNotMatch(context, /first|second|UI only/);
    assert.equal((context.match(/Assistant:/g) || []).length, 2);
});

test('persists multiple validated task items after one assistant message', (t) => {
    const workspace = makeWorkspace(t);
    const session = ensureCurrentSession(workspace);
    const turn = appendSessionTurn(workspace, session.sessionId, { text: 'Run task' });
    const firstTaskId = 'task_1234567890abcdef12345678';
    const secondTaskId = 'task_abcdefabcdefabcdefabcdef';

    const first = insertSessionTaskItem(
        workspace,
        session.sessionId,
        turn.assistantMessageIndex,
        firstTaskId,
    );
    const second = insertSessionTaskItem(
        workspace,
        session.sessionId,
        turn.assistantMessageIndex,
        secondTaskId,
    );
    const duplicate = insertSessionTaskItem(
        workspace,
        session.sessionId,
        turn.assistantMessageIndex,
        firstTaskId,
    );
    appendToAssistantMessage(workspace, session.sessionId, turn.assistantMessageIndex, 'Tasks started');

    const loaded = loadSession(workspace, session.sessionId);
    assert.equal(first.messageIndex, 2);
    assert.equal(second.messageIndex, 3);
    assert.equal(duplicate.messageIndex, 2);
    assert.equal(loaded.messages[1].text, 'Tasks started');
    assert.equal(Object.hasOwn(loaded.messages[1], 'taskId'), false);
    assert.deepEqual(loaded.messages.slice(2), [
        { type: 'task', taskId: firstTaskId },
        { type: 'task', taskId: secondTaskId },
    ]);
    assert.throws(
        () => insertSessionTaskItem(workspace, session.sessionId, turn.assistantMessageIndex, 'invalid'),
        /invalid_task_id/,
    );
    assert.doesNotMatch(formatContinuationContext(loaded), /task_123456|task_abcdef/);
});

test('ignores legacy task ids stored on assistant messages', (t) => {
    const workspace = makeWorkspace(t);
    const session = ensureCurrentSession(workspace);
    const sessionPath = path.join(workspace, '.copilot_history', `${session.sessionId}.json`);
    const record = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    record.messages = [{
        role: 'assistant',
        text: 'Legacy response',
        timestamp: new Date().toISOString(),
        attachments: [],
        references: [],
        taskId: 'task_1234567890abcdef12345678',
    }];
    fs.writeFileSync(sessionPath, `${JSON.stringify(record, null, 2)}\n`);

    const loaded = loadSession(workspace, session.sessionId);
    assert.equal(loaded.messages.length, 1);
    assert.equal(loaded.messages[0].role, 'assistant');
    assert.equal(Object.hasOwn(loaded.messages[0], 'taskId'), false);
});

test('repairs an invalid current pointer without deleting valid sessions', (t) => {
    const workspace = makeWorkspace(t);
    const original = ensureCurrentSession(workspace);
    fs.writeFileSync(path.join(workspace, '.copilot_history', 'current_session.json'), '{bad json');

    const repaired = ensureCurrentSession(workspace);
    assert.notEqual(repaired.sessionId, original.sessionId);
    assert.equal(fs.existsSync(path.join(workspace, '.copilot_history', `${original.sessionId}.json`)), true);
});

test('rejects a symlinked history directory', (t) => {
    const workspace = makeWorkspace(t);
    const outside = makeWorkspace(t);
    fs.symlinkSync(outside, path.join(workspace, '.copilot_history'));
    assert.throws(() => ensureCurrentSession(workspace), /unsafe_history_directory/);
});

test('formats history as non-replay continuation context', (t) => {
    const workspace = makeWorkspace(t);
    const session = ensureCurrentSession(workspace);
    appendSessionMessage(workspace, session.sessionId, { role: 'user', text: 'Inspect the repository' });
    appendSessionMessage(workspace, session.sessionId, { role: 'assistant', text: 'Inspection complete' });

    const context = formatContinuationContext(loadSession(workspace, session.sessionId));
    assert.match(context, /Do not execute or repeat/);
    assert.match(context, /User: Inspect the repository/);
    assert.match(context, /Assistant: Inspection complete/);
    assert.deepEqual(buildContinuationHistory(loadSession(workspace, session.sessionId)), [
        { role: 'user', message: 'Inspect the repository' },
        { role: 'assistant', message: 'Inspection complete' },
    ]);
});

test('builds role-separated continuation history without UI-only records', (t) => {
    const workspace = makeWorkspace(t);
    const session = ensureCurrentSession(workspace);
    appendSessionMessage(workspace, session.sessionId, {
        role: 'user',
        text: 'Inspect the report',
        attachments: [{ filename: 'report.md' }],
        references: [{ kind: 'workspace-path', path: 'report.md' }],
    });
    const placeholder = appendSessionMessage(workspace, session.sessionId, { role: 'assistant', text: '' });
    insertSessionTaskItem(workspace, session.sessionId, placeholder.messageIndex, 'task_1234567890abcdef12345678');
    appendSessionMessage(workspace, session.sessionId, { role: 'assistant', text: 'Report inspected' });

    const history = buildContinuationHistory(loadSession(workspace, session.sessionId));
    assert.deepEqual(history, [
        {
            role: 'user',
            message: 'Inspect the report\n\nAttachments: [{"filename":"report.md"}]\n\nReferences: [{"kind":"workspace-path","path":"report.md"}]',
        },
        { role: 'assistant', message: 'Report inspected' },
    ]);
    assert.doesNotMatch(JSON.stringify(history), /task_123456|progress/);
});
