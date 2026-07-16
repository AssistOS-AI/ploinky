import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    appendSessionTurn,
    ensureCurrentSession,
    loadSession,
} from '../../cli/server/webchat/sessionStore.js';
import { handleRuntimeRoute } from '../../cli/server/handlers/webchat/runtimeRoutes.js';
import {
    buildRuntimeKey,
    routeWorkspaceRuntimeOutput,
} from '../../cli/server/handlers/webchat/runtimeState.js';
import { createNetwork } from '../../cli/server/webchat/network.js';
import { createMessages } from '../../cli/server/webchat/messages.js';

test('input persists the assistant placeholder before writing to the TTY', (t) => {
    const workspaceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-webchat-placeholder-'));
    t.after(() => fs.rmSync(workspaceDirectory, { recursive: true, force: true }));
    const session = ensureCurrentSession(workspaceDirectory);
    const effectiveConfig = { agentName: 'demo-agent' };
    const runtimeKey = buildRuntimeKey(workspaceDirectory, session.sessionId, effectiveConfig, '');
    let sessionAtWrite = null;
    let written = '';
    const tab = {
        tty: {
            write(value) {
                sessionAtWrite = loadSession(workspaceDirectory, session.sessionId);
                written = value;
            },
        },
        workspaceDirectory,
        sessionId: session.sessionId,
        subscribers: new Map(),
        workspaceHistory: {
            workspaceDirectory,
            sessionId: session.sessionId,
            buffer: '',
            lastClientText: '',
            userInputSent: false,
            lastAssistantMessageIndex: null,
        },
    };
    const appState = { runtimes: new Map([[runtimeKey, tab]]) };
    const req = new EventEmitter();
    req.method = 'POST';
    const response = { status: null };
    const res = {
        writeHead(status) {
            response.status = status;
        },
        end() {},
    };

    handleRuntimeRoute({
        pathname: '/input',
        req,
        res,
        parsedUrl: new URL('http://localhost/input?tabId=tab-1'),
        appState,
        workspaceDirectory,
        effectiveConfig,
        agentQuery: '',
    });
    req.emit('data', JSON.stringify({ __webchatMessage: 1, text: 'Run analysis', attachments: [] }));
    req.emit('end');

    assert.equal(response.status, 204);
    assert.equal(written, 'Run analysis\n');
    assert.deepEqual(sessionAtWrite.messages.map(({ role }) => role), ['user', 'assistant']);
    assert.equal(sessionAtWrite.messages[1].text, '');
    assert.deepEqual(sessionAtWrite.messages[1].progress, []);
    assert.equal(tab.workspaceHistory.lastAssistantMessageIndex, 1);
});

test('runtime progress updates the active placeholder before final output', (t) => {
    const workspaceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-webchat-progress-'));
    t.after(() => fs.rmSync(workspaceDirectory, { recursive: true, force: true }));
    const session = ensureCurrentSession(workspaceDirectory);
    const turn = appendSessionTurn(workspaceDirectory, session.sessionId, { text: 'Run analysis' });
    const writes = [];
    const tab = {
        workspaceDirectory,
        sessionId: session.sessionId,
        subscribers: new Map([['client', { res: { write: (value) => writes.push(value) } }]]),
        workspaceHistory: {
            workspaceDirectory,
            sessionId: session.sessionId,
            buffer: '',
            lastClientText: 'Run analysis',
            userInputSent: false,
            lastAssistantMessageIndex: turn.assistantMessageIndex,
        },
        taskProtocolBuffer: '',
    };
    const appState = { runtimes: new Map([['runtime', tab]]) };

    routeWorkspaceRuntimeOutput(appState, tab, `${JSON.stringify({
        __webchatProgress: 1,
        reason: 'Reading source',
        tool: 'ignored-tool',
        stepIndex: 3,
    })}\n`);
    routeWorkspaceRuntimeOutput(appState, tab, 'Final answer\n');

    const loaded = loadSession(workspaceDirectory, session.sessionId);
    assert.deepEqual(loaded.messages[1].progress, ['Reading source']);
    assert.equal(loaded.messages[1].text, 'Final answer');
    assert.equal(JSON.stringify(loaded.messages[1]).includes('ignored-tool'), false);
    assert.match(writes.join(''), /__webchatProgress/);
    assert.match(writes.join(''), /Final answer/);
});

test('assistant output identical to the user prompt is persisted and streamed', (t) => {
    const workspaceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-webchat-identical-answer-'));
    t.after(() => fs.rmSync(workspaceDirectory, { recursive: true, force: true }));
    const session = ensureCurrentSession(workspaceDirectory);
    const turn = appendSessionTurn(workspaceDirectory, session.sessionId, { text: 'salut' });
    const writes = [];
    const tab = {
        workspaceDirectory,
        sessionId: session.sessionId,
        subscribers: new Map([['client', { res: { write: (value) => writes.push(value) } }]]),
        workspaceHistory: {
            workspaceDirectory,
            sessionId: session.sessionId,
            buffer: '',
            lastClientText: 'salut',
            userInputSent: false,
            lastAssistantMessageIndex: turn.assistantMessageIndex,
        },
        taskProtocolBuffer: '',
    };
    const appState = { runtimes: new Map([['runtime', tab]]) };

    routeWorkspaceRuntimeOutput(appState, tab, 'salut\n');

    const loaded = loadSession(workspaceDirectory, session.sessionId);
    assert.equal(loaded.messages[1].text, 'salut');
    assert.match(writes.join(''), /salut/);
});

test('explicit readline user prompt echo is neither persisted nor streamed', (t) => {
    const workspaceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-webchat-prompt-echo-'));
    t.after(() => fs.rmSync(workspaceDirectory, { recursive: true, force: true }));
    const session = ensureCurrentSession(workspaceDirectory);
    const turn = appendSessionTurn(workspaceDirectory, session.sessionId, { text: 'salut' });
    const writes = [];
    const tab = {
        workspaceDirectory,
        sessionId: session.sessionId,
        subscribers: new Map([['client', { res: { write: (value) => writes.push(value) } }]]),
        workspaceHistory: {
            workspaceDirectory,
            sessionId: session.sessionId,
            buffer: '',
            lastClientText: 'salut',
            userInputSent: false,
            lastAssistantMessageIndex: turn.assistantMessageIndex,
        },
        taskProtocolBuffer: '',
    };
    const appState = { runtimes: new Map([['runtime', tab]]) };

    routeWorkspaceRuntimeOutput(appState, tab, 'you> salut\n');

    const loaded = loadSession(workspaceDirectory, session.sessionId);
    assert.equal(loaded.messages[1].text, '');
    assert.deepEqual(writes, []);
});

test('browser renders an identical assistant answer, closes thinking, and hides the you prompt echo', async (t) => {
    const originalEventSource = globalThis.EventSource;
    const originalFetch = globalThis.fetch;
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    let eventSource = null;
    class FakeElement {
        constructor() {
            this.attributes = new Map();
            this.children = [];
            this.className = '';
            this.dataset = {};
            this.scrollHeight = 0;
            this.scrollTop = 0;
            this.clientHeight = 0;
            const classes = new Set();
            this.classList = {
                add: (...values) => values.forEach((value) => classes.add(value)),
                remove: (...values) => values.forEach((value) => classes.delete(value)),
                contains: (value) => classes.has(value),
                toggle: (value, force) => {
                    const enabled = force === undefined ? !classes.has(value) : Boolean(force);
                    if (enabled) classes.add(value);
                    else classes.delete(value);
                    return enabled;
                },
            };
        }

        addEventListener() {}

        appendChild(child) {
            this.children.push(child);
            return child;
        }

        insertBefore(child, reference) {
            const index = this.children.indexOf(reference);
            if (index < 0) return this.appendChild(child);
            this.children.splice(index, 0, child);
            return child;
        }

        prepend(child) {
            this.children.unshift(child);
        }

        querySelector() {
            return null;
        }

        querySelectorAll() {
            return [];
        }

        closest() {
            return null;
        }

        setAttribute(name, value) {
            this.attributes.set(name, String(value));
        }

        remove() {}
    }
    class FakeEventSource {
        constructor() {
            eventSource = this;
        }

        addEventListener() {}

        close() {}
    }
    globalThis.EventSource = FakeEventSource;
    globalThis.fetch = async () => ({ ok: true, status: 204 });
    globalThis.document = { createElement: () => new FakeElement() };
    globalThis.window = { requestAnimationFrame: (callback) => callback() };
    t.after(() => {
        globalThis.EventSource = originalEventSource;
        globalThis.fetch = originalFetch;
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
    });

    const typingIndicator = new FakeElement();
    const chatList = new FakeElement();
    chatList.appendChild(typingIndicator);
    const messages = createMessages({
        chatList,
        typingIndicator,
        historyGate: null,
    }, {
        markdown: null,
        initialViewMoreLineLimit: 24,
        sidePanel: {
            bindLinkDelegation() {},
            close() {},
            isActive: () => false,
            openText() {},
        },
        taskController: null,
    });
    const network = createNetwork({
        TAB_ID: 'test-tab',
        toEndpoint: (value) => value,
        dlog() {},
        showBanner() {},
        hideBanner() {},
        statusEl: null,
        statusDot: null,
        agentName: 'test-agent',
    }, {
        addClientMsg: messages.addClientMsg,
        addServerMsg: messages.addServerMsg,
        showTypingIndicator: messages.showTypingIndicator,
        hideTypingIndicator: messages.hideTypingIndicator,
        markUserInputSent: messages.markUserInputSent,
    });

    network.start();
    network.sendCommand('salut');
    await Promise.resolve();
    eventSource.onmessage({ data: JSON.stringify('salut\n') });
    eventSource.onmessage({ data: JSON.stringify('you> salut\n') });

    const incomingMessages = chatList.children.filter((child) => child.className === 'wa-message in');
    assert.equal(incomingMessages.length, 1);
    assert.equal(incomingMessages[0].children[0].dataset.fullText, 'salut');
    assert.equal(typingIndicator.classList.contains('show'), false);
});
