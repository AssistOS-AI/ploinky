import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNetwork, __testables as networkTestables } from '../../cli/server/webchat/network.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const readWebchatHandlers = () => fs.readdirSync(path.join(ROOT, 'cli/server/handlers/webchat'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => read(path.join('cli/server/handlers/webchat', name)))
    .join('\n');

test('WebChat exposes folder-session controls and lazy history loading', () => {
    const template = read('cli/server/webchat/chat.html');
    for (const id of ['sessionsBtn', 'historyGate', 'loadHistoryBtn', 'sessionDialog', 'sessionList']) {
        assert.match(template, new RegExp(`id="${id}"`));
    }
    assert.match(template, /id="sessionsBtn"[^>]*>Sessions<\/button>/);
    assert.doesNotMatch(template, /id="(?:newSessionBtn|loadSessionBtn)"/);
    const chatListStart = template.indexOf('id="chatList"');
    const historyGate = template.indexOf('id="historyGate"');
    const typingIndicator = template.indexOf('id="typingIndicator"');
    assert.ok(chatListStart >= 0 && historyGate > chatListStart && typingIndicator > historyGate);
    assert.match(template, /class="wa-history-gate" id="historyGate" hidden/);
    assert.match(template, /class="wa-history-load-button"[^>]*id="loadHistoryBtn"/);
    assert.doesNotMatch(template, /class="wa-message in wa-history-gate"/);
    assert.doesNotMatch(template, /class="wa-message-bubble wa-history-load-button"/);
    assert.match(template, /Click to load session history/);
});

test('WebChat exposes a task overlay backed by AchillesCLI commands', () => {
    const template = read('cli/server/webchat/chat.html');
    const network = read('cli/server/webchat/network.js');
    const taskRoutes = read('cli/server/handlers/webchat/taskRoutes.js');
    for (const id of ['tasksBtn', 'tasksBadge', 'tasksDialog', 'tasksList', 'taskDetail']) {
        assert.match(template, new RegExp(`id="${id}"`));
    }
    assert.match(network, /addEventListener\('task-update'/);
    assert.doesNotMatch(taskRoutes, /pathname === '\/tasks'/);
    const messages = read('cli/server/webchat/messages.js');
    const presentation = read('cli/server/webchat/taskPresentation.js');
    const taskView = read('cli/server/webchat/taskView.js');
    const taskViewTransport = read('cli/server/webchat/taskViewTransport.js');
    assert.match(messages, /attachTaskSummary/);
    assert.match(messages, /message\?\.type === 'task'/);
    assert.match(messages, /wa-task-item/);
    assert.doesNotMatch(messages, /taskAssociations/);
    assert.match(presentation, /View task details/);
    assert.match(presentation, /data.*wcTaskId|dataset\.wcTaskId/);
    assert.doesNotMatch(presentation, /wa-inline-task-arrow|wa-inline-task-log/);
    assert.match(presentation, /\(stdout\|stderr\)/);
    assert.match(presentation, /RUNNER_PREFIX_RE/);
    assert.match(presentation, /setInterval\(renderSummary, 1000\)/);
    assert.match(taskRoutes, /\/view\$/);
    assert.match(taskView, /webchat-task-update/);
    assert.match(taskViewTransport, /webchat-task-command/);
    assert.doesNotMatch(taskView, /new EventSource/);
    assert.match(taskViewTransport, /new EventSourceClass/);
});

test('task control events resolve visible WebChat commands without waiting for chat text', () => {
    assert.equal(networkTestables.resolvesVisibleTaskCommand({ event: 'list' }, '/tasks'), true);
    assert.equal(networkTestables.resolvesVisibleTaskCommand({ event: 'view' }, '/task view task-1'), true);
    assert.equal(networkTestables.resolvesVisibleTaskCommand({ event: 'update' }, '/tasks'), false);
    assert.equal(networkTestables.resolvesVisibleTaskCommand({ event: 'list' }, ''), false);
});

test('a visible /tasks command clears Thinking and identifies its list response', async () => {
    const previousEventSource = globalThis.EventSource;
    const previousFetch = globalThis.fetch;
    let eventSource;
    const hidden = [];
    const updates = [];

    class FakeEventSource {
        constructor() {
            this.listeners = new Map();
            eventSource = this;
        }

        addEventListener(name, listener) {
            this.listeners.set(name, listener);
        }

        emit(name, payload) {
            this.listeners.get(name)?.({ data: JSON.stringify(payload) });
        }

        close() {}
    }

    globalThis.EventSource = FakeEventSource;
    globalThis.fetch = async () => ({ ok: true, status: 200 });
    try {
        const network = createNetwork({
            TAB_ID: 'tab-1',
            toEndpoint: (route) => route,
            dlog: () => {},
            showBanner: () => {},
            hideBanner: () => {},
            statusEl: null,
            statusDot: null,
            agentName: 'AchillesCLI',
        }, {
            addClientMsg: () => {},
            addServerMsg: () => true,
            showTypingIndicator: () => {},
            hideTypingIndicator: (force) => hidden.push(force),
            markUserInputSent: () => {},
            onTaskUpdate: (payload, metadata) => updates.push({ payload, metadata }),
        });

        network.start();
        network.sendCommand('/tasks');
        eventSource.emit('task-update', { event: 'list', tasks: [] });

        assert.deepEqual(hidden, [true]);
        assert.equal(updates.length, 1);
        assert.equal(updates[0].metadata.visibleCommand, '/tasks');
        network.stop();
    } finally {
        globalThis.EventSource = previousEventSource;
        globalThis.fetch = previousFetch;
    }
});

test('WebChat tab identity is restored from sessionStorage before UUID fallback', () => {
    const dom = read('cli/server/webchat/domSetup.js');
    const readIndex = dom.indexOf('sessionStorage.getItem(tabStorageKey)');
    const uuidIndex = dom.indexOf('crypto.randomUUID()', readIndex);
    assert.ok(readIndex >= 0);
    assert.ok(uuidIndex > readIndex);
    assert.match(dom, /webchat_tab_id:/);
});

test('WebChat delegates conversation sessions to the agent protocol', () => {
    const handler = read('cli/server/handlers/webchat/index.js');
    const runtimeRoutes = read('cli/server/handlers/webchat/runtimeRoutes.js');
    const runtimeState = read('cli/server/handlers/webchat/runtimeState.js');
    const sessions = read('cli/server/webchat/sessions.js');
    assert.doesNotMatch(handler, /handleConversationRoute|ensureCurrentSession/);
    assert.match(runtimeRoutes, /buildRuntimeKey\(workspaceDirectory, effectiveConfig, agentQuery\)/);
    assert.match(runtimeState, /WEBCHAT_SESSION_FLAG = '__webchatSession'/);
    assert.match(sessions, /sendQuickCommand\('\/session'\)/);
    assert.doesNotMatch(sessions, /sendQuickCommand\('\/sessions'\)/);
    assert.match(sessions, /sendQuickCommand\('\/session new'\)/);
    assert.match(sessions, /`\/session resume \$\{session\.sessionId\}`/);
    assert.doesNotMatch(readWebchatHandlers(), /sessionStore\.js/);
    assert.doesNotMatch(readWebchatHandlers(), /PLOINKY_WEBCHAT_SESSION_ID/);
});

test('WebChat does not expose or call the obsolete whoami endpoint', () => {
    const handler = readWebchatHandlers();
    const client = read('cli/server/webchat/index.js');
    const domSetup = read('cli/server/webchat/domSetup.js');
    const template = read('cli/server/webchat/chat.html');

    assert.doesNotMatch(handler, /\/whoami/);
    assert.doesNotMatch(handler, /__REQUIRES_AUTH__/);
    assert.doesNotMatch(client, /whoami|requiresAuth/);
    assert.doesNotMatch(domSetup, /requiresAuth/);
    assert.doesNotMatch(template, /data-auth|__REQUIRES_AUTH__/);
});
