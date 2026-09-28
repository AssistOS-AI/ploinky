import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { createMessages, __testables } from '../../cli/server/webchat/messages.js';
import { routeWorkspaceRuntimeOutput } from '../../cli/server/handlers/webchat/runtimeState.js';
import { createSessionController } from '../../cli/server/webchat/sessions.js';

function transmitSession(messages) {
    const sessionId = '123e4567-e89b-42d3-a456-426614174000';
    const timestamp = '2026-09-08T12:00:00.000Z';
    const envelope = { __webchatSession: 1, version: 1, event: 'selected',
        session: { sessionId, createdAt: timestamp, updatedAt: timestamp, messages },
        summary: { sessionId, createdAt: timestamp, updatedAt: timestamp, hasHistory: true },
    };
    const tab = {};
    const encoded = JSON.stringify(envelope) + '\n';
    routeWorkspaceRuntimeOutput({}, tab, encoded.slice(0, 20));
    routeWorkspaceRuntimeOutput({}, tab, encoded.slice(20));
    const wire = tab.pendingSseEvents.at(-1);
    assert.ok(wire.startsWith('event: session-state\n'));
    return JSON.parse(wire.split('\n').find((line) => line.startsWith('data: ')).slice(6));
}

test('session transport preserves only recognized assistant lifecycle states', () => {
    for (const status of ['pending', 'completed', 'failed', 'interrupted']) {
        assert.equal(transmitSession([{ role: 'assistant', status }]).session.messages[0].status, status);
    }
    for (const status of [undefined, 'invented', {}, 123]) {
        assert.equal(Object.hasOwn(transmitSession([{ role: 'assistant', status }]).session.messages[0], 'status'), false);
    }
    assert.equal(Object.hasOwn(transmitSession([{ role: 'user', status: 'pending' }]).session.messages[0], 'status'), false);
});

function item(messageIndex) {
    return {
        dataset: Number.isInteger(messageIndex) ? { messageIndex: String(messageIndex) } : {},
    };
}

test('assistant output is inserted before task items that started first', () => {
    const user = item();
    const firstTask = item(2);
    const secondTask = item(3);
    const typing = item();

    assert.equal(
        __testables.findOrderedInsertionPoint(
            [user, firstTask, secondTask, typing],
            1,
            typing,
            null,
        ),
        firstTask,
    );
});

test('new task items remain ordered before the typing indicator', () => {
    const assistant = item(1);
    const firstTask = item(2);
    const typing = item();

    assert.equal(
        __testables.findOrderedInsertionPoint(
            [assistant, firstTask, typing],
            3,
            typing,
            null,
        ),
        typing,
    );
});

test('slash-command tasks wait for the command response before rendering their item', () => {
    assert.equal(__testables.shouldDeferUnindexedTask({
        event: 'started',
        task: { id: 'task-1' },
    }), true);
    assert.equal(__testables.shouldDeferUnindexedTask({
        event: 'started',
        messageIndex: 3,
        task: { id: 'task-1' },
    }), false);
    assert.equal(__testables.shouldDeferUnindexedTask({
        event: 'update',
        task: { id: 'task-1' },
    }), false);
});

function makeMessageElement() {
    return {
        dataset: {},
        children: [],
        scrollHeight: 0,
        scrollTop: 0,
        clientHeight: 0,
        addEventListener() {},
        querySelector() { return null; },
        closest() { return null; },
        appendChild(child) { this.insertBefore(child, null); return child; },
        insertBefore(child, next) {
            child.remove?.();
            const index = next ? this.children.indexOf(next) : this.children.length;
            assert.notEqual(index, -1);
            this.children.splice(index, 0, child);
            child.parentElement = this;
        },
        remove() {
            if (!this.parentElement) return;
            const children = this.parentElement.children;
            children.splice(children.indexOf(this), 1);
            this.parentElement = null;
        },
    };
}

test('pending history keeps thinking visible and hides the empty assistant bubble without losing its anchor', (t) => {
    const oldDocument = globalThis.document;
    const oldWindow = globalThis.window;
    globalThis.document = { createElement: makeMessageElement, addEventListener() {} };
    globalThis.window = { requestAnimationFrame: (callback) => callback() };
    t.after(() => { globalThis.document = oldDocument; globalThis.window = oldWindow; });
    const chatList = makeMessageElement();
    const classes = new Set();
    const typingIndicator = { ...makeMessageElement(),
        classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
        setAttribute() {},
    };
    chatList.appendChild(typingIndicator);
    const messages = createMessages({ chatList, typingIndicator }, { sidePanel: { isActive: () => false } });
    const sessions = createSessionController({ elements: {}, messages, network: {}, showBanner() {}, hideBanner() {} });
    const assistant = { id: 'reply', role: 'assistant', text: '', status: 'pending' };
    sessions.handleSessionState(transmitSession([assistant]));
    assert.equal(classes.has('show'), true);
    assert.equal(chatList.children[0].dataset.messageId, 'reply');
    assert.equal(chatList.children[0].children[0].hidden, true);
    for (const status of ['completed', 'failed', 'interrupted']) {
        sessions.handleSessionState(transmitSession([assistant]));
        sessions.handleSessionState(transmitSession([{ ...assistant, status, text: 'Hello.' }]));
        assert.equal(classes.has('show'), false);
        assert.equal(chatList.children[0].children[0].hidden, false);
    }
});

test('pending bubble visibility overrides the ordinary bubble display rule', () => {
    const css = readFileSync(new URL('../../cli/server/webchat/webchat.css', import.meta.url), 'utf8');
    assert.match(css, /\.wa-message-bubble\[hidden\]\s*\{\s*display:\s*none;/);
});

test('the typing indicator shows one auto-replacing status line and no activity list', () => {
    const oldDocument = globalThis.document;
    const oldWindow = globalThis.window;
    globalThis.document = { createElement: makeMessageElement };
    globalThis.window = { requestAnimationFrame: (callback) => callback() };
    try {
        const chatList = makeMessageElement();
        const label = { textContent: 'Thinking', title: '' };
        const list = { children: [], replaceChildren() { this.children = []; } };
        const classes = new Set();
        const typingIndicator = { ...makeMessageElement(),
            classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
            setAttribute() {},
            querySelector(selector) {
                if (selector === '.wa-typing-label') return label;
                if (selector === '.wa-typing-progress') return list;
                return null;
            },
        };
        chatList.appendChild(typingIndicator);
        const messages = createMessages({ chatList, typingIndicator }, { sidePanel: { isActive: () => false } });
        messages.addProgressEvent({ reason: 'Connecting to robot "default"' });
        assert.equal(label.textContent, 'Connecting to robot "default"');
        messages.addProgressEvent({ reason: 'Starting ALA' });
        assert.equal(label.textContent, 'Starting ALA');
        assert.equal(list.children.length, 0);
        messages.markUserInputSent();
        assert.equal(label.textContent, 'Thinking');
    } finally {
        globalThis.document = oldDocument;
        globalThis.window = oldWindow;
    }
});

test('overlapping live tasks follow stable assistant anchors across session switch and restore', (t) => {
    const oldDocument = globalThis.document;
    const oldWindow = globalThis.window;
    globalThis.document = { createElement: makeMessageElement };
    globalThis.window = { requestAnimationFrame: (callback) => callback() };
    t.after(() => { globalThis.document = oldDocument; globalThis.window = oldWindow; });
    const chatList = makeMessageElement();
    const messages = createMessages({ chatList }, { sidePanel: { isActive: () => false } });
    const ids = () => chatList.children.map((node) => node.dataset.taskId || node.dataset.messageId);
    const task = (id, sessionId, assistantMessageId) => ({
        event: 'started', task: { id, sessionId, assistantMessageId, turnId: `turn-${id}` },
    });
    messages.setSessionId('session-A');
    messages.associateTask(task('task-A1', 'session-A', 'assistant-A'));
    messages.associateTask(task('task-B', 'session-B', 'assistant-B'));
    assert.deepEqual(ids(), []); // No anchor/history yet: neither task belongs at the current tail.
    messages.renderHistory([{ id: 'assistant-A', role: 'assistant', text: '' }]);
    assert.deepEqual(ids(), ['assistant-A', 'task-A1']);
    messages.associateTask(task('task-A2', 'session-A', 'assistant-A'));
    messages.associateTask(task('task-A1', 'session-A', 'assistant-A'));
    assert.deepEqual(ids(), ['assistant-A', 'task-A1', 'task-A2']);

    messages.setSessionId('session-B');
    messages.renderHistory([{ id: 'assistant-B', role: 'assistant', text: 'B answer' }]);
    messages.associateTask(task('task-A3', 'session-A', 'assistant-A'));
    assert.deepEqual(ids(), ['assistant-B', 'task-B']);
    messages.setSessionId('session-A');
    messages.renderHistory([
        { id: 'assistant-A', role: 'assistant', text: 'A answer' },
        { type: 'task', taskId: 'task-A1' },
        { type: 'task', taskId: 'task-A2' },
        { id: 'later-A', role: 'assistant', text: 'Later answer' },
    ]);
    assert.deepEqual(ids(), ['assistant-A', 'task-A1', 'task-A2', 'task-A3', 'later-A']);
});

test('generic indexed tasks retain ordered placement without session metadata', (t) => {
    const oldDocument = globalThis.document;
    const oldWindow = globalThis.window;
    globalThis.document = { createElement: makeMessageElement };
    globalThis.window = { requestAnimationFrame: (callback) => callback() };
    t.after(() => { globalThis.document = oldDocument; globalThis.window = oldWindow; });
    const chatList = makeMessageElement();
    const messages = createMessages({ chatList }, { sidePanel: { isActive: () => false } });
    messages.associateTask({ event: 'started', messageIndex: 2, task: { id: 'generic-task' } });
    messages.addServerMsg('Answer', { messageIndex: 1 });
    assert.deepEqual(chatList.children.map((node) => node.dataset.messageIndex), ['1', '2']);
});
