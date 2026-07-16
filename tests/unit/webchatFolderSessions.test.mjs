import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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

test('WebChat exposes a workspace task overlay and generic task endpoints', () => {
    const template = read('cli/server/webchat/chat.html');
    const network = read('cli/server/webchat/network.js');
    const taskRoutes = read('cli/server/handlers/webchat/taskRoutes.js');
    for (const id of ['tasksBtn', 'tasksBadge', 'tasksDialog', 'tasksList', 'taskDetail']) {
        assert.match(template, new RegExp(`id="${id}"`));
    }
    assert.match(network, /addEventListener\('task-update'/);
    assert.match(taskRoutes, /pathname === '\/tasks' && req\.method === 'GET'/);
    assert.match(taskRoutes, /\/tasks\\\/\(task_/);
    const messages = read('cli/server/webchat/messages.js');
    const presentation = read('cli/server/webchat/taskPresentation.js');
    const taskView = read('cli/server/webchat/taskView.js');
    assert.match(messages, /attachTaskSummary/);
    assert.match(messages, /message\?\.type === 'task'/);
    assert.match(messages, /wa-task-item/);
    assert.doesNotMatch(messages, /taskAssociations/);
    assert.match(presentation, /View live logs/);
    assert.match(presentation, /data.*wcTaskId|dataset\.wcTaskId/);
    assert.doesNotMatch(presentation, /wa-inline-task-arrow|wa-inline-task-log/);
    assert.match(presentation, /\(stdout\|stderr\)/);
    assert.match(presentation, /RUNNER_PREFIX_RE/);
    assert.match(presentation, /setInterval\(renderSummary, 1000\)/);
    assert.match(taskRoutes, /\/view\$/);
    assert.match(taskView, /webchat-task-update/);
    assert.doesNotMatch(taskView, /new EventSource/);
});

test('WebChat tab identity is restored from sessionStorage before UUID fallback', () => {
    const dom = read('cli/server/webchat/domSetup.js');
    const readIndex = dom.indexOf('sessionStorage.getItem(tabStorageKey)');
    const uuidIndex = dom.indexOf('crypto.randomUUID()', readIndex);
    assert.ok(readIndex >= 0);
    assert.ok(uuidIndex > readIndex);
    assert.match(dom, /webchat_tab_id:/);
});

test('WebChat session API is authenticated before folder files are handled', () => {
    const handler = read('cli/server/handlers/webchat/index.js');
    const conversationRoutes = read('cli/server/handlers/webchat/conversationRoutes.js');
    const runtimeRoutes = read('cli/server/handlers/webchat/runtimeRoutes.js');
    const authGate = handler.indexOf('if (!authorized(req))');
    const sessionDispatch = handler.indexOf('await handleConversationRoute');
    assert.ok(authGate >= 0);
    assert.ok(sessionDispatch > authGate);
    assert.match(conversationRoutes, /pathname === '\/sessions' && req\.method === 'GET'/);
    assert.match(runtimeRoutes, /buildRuntimeKey\(workspaceDirectory, currentSession\.sessionId/);
    assert.match(runtimeRoutes, /ttyFactory\.create\(ssoUser, \{[\s\S]*?hasHistory: currentSession\.messages\.length > 0/);
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
