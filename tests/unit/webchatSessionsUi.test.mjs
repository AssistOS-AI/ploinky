import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
        assert.equal(historyGate.hidden, false);
        loadHistoryBtn.listeners.get('click')();
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

test('session controls preserve their established styling and lazy history gate', () => {
    const css = readFileSync(new URL('../../cli/server/webchat/webchat.css', import.meta.url), 'utf8');
    const template = readFileSync(new URL('../../cli/server/webchat/chat.html', import.meta.url), 'utf8');
    assert.match(css, /\.wa-session-btn:hover\s*\{\s*background:\s*#086b58;\s*\}/);
    assert.match(css, /\.wa-session-list-new \.wa-session-list-preview/);
    assert.match(template, /Click to load session history/);
});
