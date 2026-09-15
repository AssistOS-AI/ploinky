import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionController, formatRelativeTime } from '../../cli/server/webchat/sessions.js';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';

function makeElement() {
    return {
        children: [],
        dataset: {},
        hidden: true,
        disabled: false,
        listeners: new Map(),
        append(...children) { this.children.push(...children); },
        appendChild(child) { this.children.push(child); },
        replaceChildren(...children) { this.children = children; },
        addEventListener(type, listener) { this.listeners.set(type, listener); },
    };
}

function sessionState(event = 'current', messages = []) {
    return {
        event,
        session: {
            sessionId: SESSION_ID,
            createdAt: '2026-07-23T10:00:00.000Z',
            updatedAt: '2026-07-23T10:01:00.000Z',
            messages,
        },
        summary: {
            sessionId: SESSION_ID,
            preview: 'Earlier question',
            createdAt: '2026-07-23T10:00:00.000Z',
            updatedAt: '2026-07-23T10:01:00.000Z',
            hasHistory: messages.length > 0,
        },
    };
}

test('formats WebChat session activity as compact relative English time', () => {
    const now = Date.parse('2026-07-13T12:00:00.000Z');
    assert.equal(formatRelativeTime('2026-07-13T11:59:40.000Z', now), 'just now');
    assert.equal(formatRelativeTime('2026-07-13T10:00:00.000Z', now), '2 hours ago');
    assert.equal(formatRelativeTime('2026-07-12T12:00:00.000Z', now), '1 day ago');
});

test('session UI sends AchillesCLI slash commands and renders protocol responses', () => {
    const originalDocument = globalThis.document;
    const sessionsBtn = makeElement();
    const historyGate = makeElement();
    const loadHistoryBtn = makeElement();
    const sessionDialog = makeElement();
    const sessionList = makeElement();
    const commands = [];
    const rendered = [];
    globalThis.document = { createElement: makeElement, addEventListener() {} };
    try {
        const controller = createSessionController({
            elements: { sessionsBtn, historyGate, loadHistoryBtn, sessionDialog, sessionList },
            messages: {
                clearMessages() {},
                renderHistory(messages) { rendered.push(messages); },
                addClientMsg() {},
            },
            network: { sendQuickCommand(command) { commands.push(command); return true; } },
            showBanner() {},
            hideBanner() {},
        });

        assert.equal(sessionsBtn.disabled, true);
        controller.handleSessionState(sessionState('current', [{ role: 'user', text: 'Earlier question' }]));
        assert.equal(sessionsBtn.disabled, false);
        assert.equal(historyGate.hidden, true);
        assert.equal(rendered.length, 1);

        sessionsBtn.listeners.get('click')();
        assert.equal(commands.at(-1), '/session');
        controller.handleSessionState({
            event: 'list',
            currentSessionId: SESSION_ID,
            sessions: [sessionState().summary],
        });
        assert.equal(sessionList.children[0].children[0].textContent, 'New');
        sessionList.children[0].listeners.get('click')();
        assert.equal(commands.at(-1), '/session new');

        controller.handleSessionState({
            event: 'list',
            currentSessionId: SESSION_ID,
            sessions: [sessionState().summary],
        });
        sessionList.children[1].listeners.get('click')();
        assert.equal(commands.at(-1), `/session resume ${SESSION_ID}`);
    } finally {
        globalThis.document = originalDocument;
    }
});

test('selected session history is rendered immediately', () => {
    const originalDocument = globalThis.document;
    globalThis.document = { createElement: makeElement, addEventListener() {} };
    const rendered = [];
    try {
        const controller = createSessionController({
            elements: {},
            messages: {
                clearMessages() {},
                renderHistory(messages) { rendered.push(messages); },
                addClientMsg() {},
            },
            network: { sendQuickCommand() {} },
            showBanner() {},
            hideBanner() {},
        });
        controller.handleSessionState(sessionState('selected', [{ role: 'assistant', text: 'Loaded' }]));
        assert.equal(rendered[0][0].text, 'Loaded');
        assert.equal(controller.isHistoryLoaded(), true);
    } finally {
        globalThis.document = originalDocument;
    }
});

test('execution snapshots leave the thinking lifecycle to the history renderer', (t) => {
    const originalDocument = globalThis.document;
    globalThis.document = { addEventListener() {} };
    t.after(() => { globalThis.document = originalDocument; });
    let thinking = false;
    const controller = createSessionController({
        elements: {},
        messages: {
            renderHistory(messages) { thinking = messages.some((message) => message.status === 'pending'); },
            hideTypingIndicator() { thinking = false; },
        },
        network: {}, showBanner() {}, hideBanner() {},
    });
    controller.handleSessionState(sessionState('current'));
    controller.handleSessionState(sessionState('updated', [{ role: 'assistant', status: 'pending', text: '' }]));
    assert.equal(thinking, true);
    controller.handleSessionState(sessionState('updated', [{ role: 'assistant', status: 'completed', text: 'Hello' }]));
    assert.equal(thinking, false);
});

test('execution snapshots and remote echoes never switch the selected conversation', (t) => {
    const originalDocument = globalThis.document;
    globalThis.document = { createElement: makeElement, addEventListener() {} };
    t.after(() => { globalThis.document = originalDocument; });
    const rendered = [];
    const remote = [];
    const errors = [];
    const controller = createSessionController({
        elements: {},
        messages: {
            renderHistory(messages) { rendered.push(messages); },
            addClientMsg(text) { remote.push(text); },
        },
        network: {},
        showBanner: (text) => errors.push(text),
        hideBanner() {},
    });
    const selected = sessionState('selected', [{ id: 'anchor-A', role: 'assistant', text: 'A' }]);
    controller.handleSessionState(selected);
    const other = sessionState('updated', [{ id: 'anchor-B', role: 'assistant', text: 'B' }]);
    other.session.sessionId = other.summary.sessionId = 'other-session';
    controller.handleSessionState(other);
    controller.addRemoteUserMessage({ text: 'B user' }, { sessionId: 'other-session' });
    controller.handleSessionState({ event: 'error', sessionId: 'other-session', error: 'B failed' });
    assert.equal(controller.getCurrentSession().sessionId, SESSION_ID);
    assert.equal(rendered.length, 1);
    assert.deepEqual(remote, []);
    assert.deepEqual(errors, []);
    controller.handleSessionState(sessionState('updated', [{ id: 'anchor-A', role: 'assistant', text: 'A finished' }]));
    assert.equal(rendered.at(-1)[0].text, 'A finished');
    controller.loadHistory();
    assert.equal(rendered.at(-1)[0].id, 'anchor-A');
    controller.handleSessionState({ event: 'error', sessionId: SESSION_ID, error: 'Native home mismatch' });
    assert.deepEqual(errors, ['Native home mismatch']);
});


test('history automatically shows a bounded tail and prepends pages without jumping or mixing sessions', async (t) => {
    const previousDocument = globalThis.document;
    const previousFrame = globalThis.requestAnimationFrame;
    globalThis.document = { createElement: makeElement, addEventListener() {} };
    globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
    t.after(() => { globalThis.document = previousDocument; globalThis.requestAnimationFrame = previousFrame; });
    const chatList = makeElement();
    chatList.classList = { add() {}, remove() {} };
    chatList.scrollHeight = 0;
    chatList.scrollTop = 0;
    chatList.clientHeight = 500;
    const historyGate = makeElement();
    const rendered = [];
    const controller = createSessionController({ elements: { chatList, historyGate }, network: {}, showBanner() {}, hideBanner() {},
        messages: { renderHistory(page, options) {
            rendered.push({ page, options });
            chatList.scrollHeight = (options.prepend ? chatList.scrollHeight : 0) + page.length * 20;
        } } });
    const all = Array.from({ length: 230 }, (_, index) => ({ role: 'user', id: String(index), text: String(index) }));
    controller.handleSessionState(sessionState('current', all));
    assert.equal(rendered[0].page.length, 100);
    assert.equal(rendered[0].options.startIndex, 130);
    chatList.scrollTop = 40;
    const loading = controller.loadOlder();
    assert.equal(historyGate.hidden, false);
    await controller.loadOlder();
    await loading;
    assert.equal(rendered.length, 2, 'concurrent scrolls share one page');
    assert.equal(rendered[1].page.length, 50);
    assert.equal(rendered[1].options.startIndex, 80);
    assert.equal(rendered[1].options.prepend, true);
    assert.equal(chatList.scrollTop, 1040);
    assert.equal(historyGate.hidden, true);
    const pending = controller.loadOlder();
    const replacement = sessionState('selected', []);
    replacement.summary.sessionId = 'new-session';
    controller.handleSessionState(replacement);
    await pending;
    assert.deepEqual(rendered.at(-1).page, []);
    assert.equal(rendered.length, 3, 'old pending page cannot enter the new session');
});
