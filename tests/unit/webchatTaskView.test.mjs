import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { createSidePanel } from '../../cli/server/webchat/sidePanel.js';

test('side panel forwards only the active task update to its same-origin iframe', (t) => {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const originalSetTimeout = globalThis.setTimeout;
    const posted = [];
    const makeElement = (tagName = 'div') => ({
        tagName: tagName.toUpperCase(),
        children: [],
        className: '',
        dataset: {},
        style: {},
        contentWindow: tagName === 'iframe' ? {
            postMessage(message, origin) {
                posted.push({ message, origin });
            },
        } : null,
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        addEventListener() {},
    });
    const panelWrapper = makeElement();
    const sidePanel = makeElement();
    sidePanel.querySelector = () => panelWrapper;
    const chatContainer = makeElement();
    chatContainer.classList = { add() {}, remove() {} };
    globalThis.document = { createElement: (tagName) => makeElement(tagName) };
    globalThis.window = { location: { origin: 'http://localhost:8080' } };
    globalThis.setTimeout = () => 0;
    t.after(() => {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
        globalThis.setTimeout = originalSetTimeout;
    });

    const api = createSidePanel({
        chatContainer,
        chatArea: null,
        sidePanel,
        sidePanelContent: null,
        sidePanelClose: null,
        sidePanelTitle: null,
        sidePanelResizer: null,
    }, { markdown: null });
    const taskId = 'task_1234567890abcdef12345678';
    api.openIframe(`http://localhost:8080/webchat/tasks/${taskId}/view`, { taskId });
    api.postTaskUpdate({ task: { id: 'task_abcdefabcdefabcdefabcdef' } });
    api.postTaskUpdate({ task: { id: taskId }, logAppend: 'line\n', logOffset: 5 });

    assert.equal(posted.length, 1);
    assert.equal(posted[0].origin, 'http://localhost:8080');
    assert.equal(posted[0].message.type, 'webchat-task-update');
    assert.equal(posted[0].message.payload.task.id, taskId);
});

test('side panel forwards task commands declared by AchillesCLI and rejects undeclared commands', (t) => {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const originalSetTimeout = globalThis.setTimeout;
    const commands = [];
    const posted = [];
    const interactionResponses = [];
    let messageHandler = null;
    const makeElement = (tagName = 'div') => ({
        children: [],
        className: '',
        dataset: {},
        style: {},
        contentWindow: tagName === 'iframe' ? { postMessage(message) { posted.push(message); } } : null,
        appendChild(child) { this.children.push(child); return child; },
        addEventListener() {},
    });
    const panelWrapper = makeElement();
    const sidePanel = makeElement();
    sidePanel.querySelector = () => panelWrapper;
    const chatContainer = makeElement();
    chatContainer.classList = { add() {}, remove() {} };
    globalThis.document = { createElement: (tagName) => makeElement(tagName) };
    globalThis.window = {
        location: { origin: 'http://localhost:8080' },
        addEventListener(type, listener) {
            if (type === 'message') messageHandler = listener;
        },
    };
    globalThis.setTimeout = () => 0;
    t.after(() => {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
        globalThis.setTimeout = originalSetTimeout;
    });

    const api = createSidePanel({
        chatContainer,
        chatArea: null,
        sidePanel,
        sidePanelContent: null,
        sidePanelClose: null,
        sidePanelTitle: null,
        sidePanelResizer: null,
    }, {
        markdown: null,
        sendQuickCommand: (command) => commands.push(command),
        sendInteractionResponse: (...args) => interactionResponses.push(args),
    });
    const taskId = 'task_1234567890abcdef12345678';
    const frame = api.openIframe(`http://localhost:8080/webchat/tasks/${taskId}/view`, { taskId });
    api.postTaskUpdate({
        task: {
            id: taskId,
            commands: [{ name: '/model', command: `/task model ${taskId}` }],
        },
    });
    const send = (command) => messageHandler({
        origin: 'http://localhost:8080',
        source: frame.contentWindow,
        data: { type: 'webchat-task-command', taskId, command },
    });
    send(`/task login ${taskId}`);
    send(`/task model ${taskId}`);

    assert.deepEqual(commands, [`/task model ${taskId}`]);
    assert.equal(api.postTaskInteraction({
        id: 'task_control_12345678',
        targetTaskId: taskId,
        options: [{ id: 'choice_0', label: 'GPT Test' }],
    }), true);
    assert.equal(posted.at(-1).type, 'webchat-task-interaction-request');
    messageHandler({
        origin: 'http://localhost:8080',
        source: frame.contentWindow,
        data: {
            type: 'webchat-task-interaction-response',
            taskId,
            interactionId: 'task_control_12345678',
            optionId: 'choice_0',
        },
    });
    assert.equal(api.postTaskInteraction({
        id: 'task_control_87654321',
        targetTaskId: taskId,
        options: [],
        input: { type: 'secret', maxLength: 1024 },
    }), true);
    messageHandler({
        origin: 'http://localhost:8080',
        source: frame.contentWindow,
        data: {
            type: 'webchat-task-interaction-response',
            taskId,
            interactionId: 'task_control_87654321',
            cancelled: true,
        },
    });
    assert.deepEqual(interactionResponses, [
        ['task_control_12345678', 'choice_0', null],
        ['task_control_87654321', null, null, true],
    ]);
});

test('opening the same active task view reuses its iframe and preserves its log state', (t) => {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const originalSetTimeout = globalThis.setTimeout;
    const createdFrames = [];
    const makeElement = (tagName = 'div') => {
        const element = {
            tagName: tagName.toUpperCase(),
            children: [],
            className: '',
            dataset: {},
            style: {},
            contentWindow: tagName === 'iframe' ? {} : null,
            appendChild(child) {
                this.children.push(child);
                return child;
            },
            addEventListener() {},
        };
        if (tagName === 'iframe') createdFrames.push(element);
        return element;
    };
    const panelWrapper = makeElement();
    const sidePanel = makeElement();
    sidePanel.querySelector = () => panelWrapper;
    const chatContainer = makeElement();
    chatContainer.classList = { add() {}, remove() {} };
    globalThis.document = { createElement: (tagName) => makeElement(tagName) };
    globalThis.window = { location: { origin: 'http://localhost:8080' } };
    globalThis.setTimeout = () => 0;
    t.after(() => {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
        globalThis.setTimeout = originalSetTimeout;
    });

    const api = createSidePanel({
        chatContainer,
        chatArea: null,
        sidePanel,
        sidePanelContent: null,
        sidePanelClose: null,
        sidePanelTitle: null,
        sidePanelResizer: null,
    }, { markdown: null });
    const taskId = 'task_1234567890abcdef12345678';
    const url = `http://localhost:8080/webchat/tasks/${taskId}/view`;
    const first = api.openIframe(url, { taskId });
    const second = api.openIframe(url, { taskId });

    assert.equal(second, first);
    assert.equal(createdFrames.length, 1);
});

test('switching task views reloads the complete log after each iframe is ready', (t) => {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const originalSetTimeout = globalThis.setTimeout;
    const commands = [];
    const createdFrames = [];
    const makeElement = (tagName = 'div') => {
        const listeners = new Map();
        const element = {
            tagName: tagName.toUpperCase(),
            children: [],
            className: '',
            dataset: {},
            style: {},
            contentWindow: tagName === 'iframe' ? {} : null,
            appendChild(child) {
                this.children.push(child);
                return child;
            },
            addEventListener(type, listener) {
                listeners.set(type, listener);
            },
            dispatch(type) {
                listeners.get(type)?.();
            },
        };
        if (tagName === 'iframe') createdFrames.push(element);
        return element;
    };
    const panelWrapper = makeElement();
    const sidePanel = makeElement();
    sidePanel.querySelector = () => panelWrapper;
    const chatContainer = makeElement();
    chatContainer.classList = { add() {}, remove() {} };
    globalThis.document = { createElement: (tagName) => makeElement(tagName) };
    globalThis.window = { location: { origin: 'http://localhost:8080' } };
    globalThis.setTimeout = () => 0;
    t.after(() => {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
        globalThis.setTimeout = originalSetTimeout;
    });

    const api = createSidePanel({
        chatContainer,
        chatArea: null,
        sidePanel,
        sidePanelContent: null,
        sidePanelClose: null,
        sidePanelTitle: null,
        sidePanelResizer: null,
    }, {
        markdown: null,
        sendQuickCommand: (command) => commands.push(command),
    });
    const firstTaskId = 'task_1234567890abcdef12345678';
    const secondTaskId = 'task_abcdefabcdefabcdefabcdef';

    api.openIframe(`http://localhost:8080/webchat/tasks/${firstTaskId}/view`, { taskId: firstTaskId });
    createdFrames[0].dispatch('load');
    api.openIframe(`http://localhost:8080/webchat/tasks/${secondTaskId}/view`, { taskId: secondTaskId });
    createdFrames[1].dispatch('load');
    api.openIframe(`http://localhost:8080/webchat/tasks/${firstTaskId}/view`, { taskId: firstTaskId });
    createdFrames[2].dispatch('load');

    assert.deepEqual(commands, [
        `/task view ${firstTaskId}`,
        `/task view ${secondTaskId}`,
        `/task view ${firstTaskId}`,
    ]);
});

test('task view renders a complete terminal log snapshot without waiting for another live delta', async (t) => {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const originalLocalStorage = globalThis.localStorage;
    const originalSetInterval = globalThis.setInterval;
    const listeners = new Map();
    const elements = new Map();
    const commands = [];
    const makeElement = () => ({
        children: [],
        className: '',
        dataset: {},
        style: {},
        hidden: false,
        disabled: false,
        textContent: '',
        value: '',
        scrollHeight: 40,
        scrollTop: 0,
        clientHeight: 100,
        selectionStart: 0,
        selectionEnd: 0,
        addEventListener() {},
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        replaceChildren(...children) {
            this.children = children;
        },
        setRangeText() {},
        dispatchEvent() {},
        requestSubmit() {},
    });
    for (const id of [
        'taskAgent',
        'taskModel',
        'taskDescription',
        'taskStatus',
        'taskDuration',
        'taskError',
        'taskStop',
        'taskActionError',
        'taskLog',
        'taskContinuation',
        'taskContinuationInput',
        'taskContinuationSend',
        'taskContinuationError',
    ]) {
        elements.set(id, makeElement());
    }
    const parent = {
        postMessage(message) {
            commands.push(message.command);
        },
    };
    globalThis.window = {
        location: {
            pathname: '/webchat/tasks/task_1234567890abcdef12345678/view',
            origin: 'http://localhost:8080',
        },
        parent,
        addEventListener(type, listener) {
            listeners.set(type, listener);
        },
    };
    globalThis.document = {
        body: { dataset: {} },
        title: '',
        getElementById: (id) => elements.get(id),
        createElement: () => makeElement(),
    };
    globalThis.localStorage = { getItem: () => null };
    globalThis.setInterval = () => 0;
    t.after(() => {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
        globalThis.localStorage = originalLocalStorage;
        globalThis.setInterval = originalSetInterval;
    });

    await import(`../../cli/server/webchat/taskView.js?snapshot=${Date.now()}`);
    listeners.get('message')?.({
        origin: 'http://localhost:8080',
        source: parent,
        data: {
            type: 'webchat-task-update',
            payload: {
                event: 'view',
                task: {
                    id: 'task_1234567890abcdef12345678',
                    targetAgent: 'opencodeAgent',
                    description: 'Finished task',
                    status: 'ongoing',
                },
                log: {
                    text: 'historical line\nfinal answer\n',
                    nextOffset: 29,
                },
            },
        },
    });

    assert.equal(elements.get('taskAgent').textContent, 'opencodeAgent');
    assert.equal(elements.get('taskModel').textContent, 'default');
    assert.equal(elements.get('taskDescription').textContent, 'Finished task');
    assert.deepEqual(
        elements.get('taskLog').children.map((child) => child.textContent),
        ['historical line', 'final answer', '\u00a0'],
    );
    assert.match(elements.get('taskLog').children[1].className, /is-intermediate/);

    listeners.get('message')?.({
        origin: 'http://localhost:8080',
        source: parent,
        data: {
            type: 'webchat-task-update',
            payload: {
                event: 'update',
                task: {
                    id: 'task_1234567890abcdef12345678',
                    targetAgent: 'piAgent',
                    description: 'Finished task',
                    status: 'finished',
                    execution: {
                        model: {
                            key: 'anthropic/claude-sonnet-4',
                            model: 'claude-sonnet-4',
                            label: 'Claude Sonnet 4',
                        },
                    },
                    turn: 1,
                    finalOutputRanges: [{ turn: 1, offset: 16, length: 12 }],
                },
            },
        },
    });

    assert.equal(elements.get('taskAgent').textContent, 'piAgent');
    assert.equal(elements.get('taskModel').textContent, 'Claude Sonnet 4');
    assert.equal(elements.get('taskDescription').textContent, 'Finished task');
    assert.match(elements.get('taskLog').children[1].className, /is-final/);

    const chunkedTask = {
        id: 'task_1234567890abcdef12345678',
        targetAgent: 'piAgent',
        description: 'Finished task',
        status: 'finished',
    };
    const sendTaskPayload = (payload) => listeners.get('message')?.({
        origin: 'http://localhost:8080',
        source: parent,
        data: { type: 'webchat-task-update', payload },
    });
    sendTaskPayload({
        event: 'view',
        task: chunkedTask,
        log: { text: '', nextOffset: 24, reset: true },
        logChunk: { phase: 'start', count: 2, nextOffset: 24 },
    });
    sendTaskPayload({
        event: 'view-log-chunk',
        task: chunkedTask,
        logChunk: { phase: 'chunk', index: 0, count: 2, text: 'chunked historical\n', nextOffset: 24 },
    });
    assert.notEqual(elements.get('taskLog').children[0].textContent, 'chunked historical');
    sendTaskPayload({
        event: 'view-log-chunk',
        task: chunkedTask,
        logChunk: { phase: 'chunk', index: 1, count: 2, text: 'done\n', nextOffset: 24 },
    });
    assert.deepEqual(
        elements.get('taskLog').children.map((child) => child.textContent),
        ['chunked historical', 'done', '\u00a0'],
    );
    await Promise.resolve();
    assert.deepEqual(commands, ['/task view task_1234567890abcdef12345678']);
});

test('task view sends continuation through the AchillesCLI command bridge', () => {
    const source = fs.readFileSync(
        new URL('../../cli/server/webchat/taskView.js', import.meta.url),
        'utf8',
    );
    const html = fs.readFileSync(
        new URL('../../cli/server/webchat/task-view.html', import.meta.url),
        'utf8',
    );
    assert.match(html, /id="taskContinuationInput"/);
    assert.ok(html.indexOf('id="taskAgent"') < html.indexOf('id="taskModel"'));
    assert.ok(html.indexOf('id="taskModel"') < html.indexOf('id="taskDescription"'));
    assert.match(source, /`\/task continue \$\{taskId\} \$\{message\}`/);
    assert.match(source, /TERMINAL_STATUSES = new Set\(\['finished', 'stopped', 'error'\]\)/);
    assert.match(source, /TERMINAL_STATUSES\.has\(task\?\.status\)/);
    assert.match(source, /applyUpdate\(payload\)/);
    assert.match(source, /task\?\.commands/);
    assert.match(source, /requestCommand\(`\$\{taskCommand\.command\}/);
    assert.match(source, /if \(taskCommand\) \{[\s\S]*?await startTaskCommand\(taskCommand, suffix\);[\s\S]*?return;[\s\S]*?\}/);
    assert.doesNotMatch(source, /taskControlClient|set_model|login_start/);
    assert.doesNotMatch(source, /Task model set to/);
    assert.match(source, /let logResyncPending = false/);
    assert.match(source, /if \(!logResyncPending\)/);
    assert.match(source, /if \(!transport\.embedded\) void syncLog\(\)\.catch\(showLoadError\)/);
    assert.match(source, /Loading task…/);
    assert.doesNotMatch(source, /\.then\(\(\) => applyLogUpdate\(payload\)\)/);
});

test('task continuation input submits on Enter and auto-resizes without manual resizing', () => {
    const source = fs.readFileSync(
        new URL('../../cli/server/webchat/taskView.js', import.meta.url),
        'utf8',
    );
    const css = fs.readFileSync(
        new URL('../../cli/server/webchat/webchat.css', import.meta.url),
        'utf8',
    );
    assert.match(source, /MAX_CONTINUATION_INPUT_HEIGHT_PX = 132/);
    assert.match(source, /continuationInput\.addEventListener\('input', autoResizeContinuationInput\)/);
    assert.match(source, /if \(event\.ctrlKey \|\| event\.metaKey\)/);
    assert.match(source, /if \(event\.shiftKey\) return/);
    assert.match(source, /continuationForm\.requestSubmit\(\)/);
    assert.match(
        css,
        /\.wa-task-continuation textarea\s*\{[^}]*max-height:\s*132px[^}]*resize:\s*none/s,
    );
});

test('task logs expose a persistent high-contrast scrollbar', () => {
    const css = fs.readFileSync(
        new URL('../../cli/server/webchat/webchat.css', import.meta.url),
        'utf8',
    );
    assert.match(
        css,
        /\.wa-task-log\s*\{[^}]*overflow-y:\s*scroll[^}]*scrollbar-gutter:\s*stable[^}]*scrollbar-color:/s,
    );
    assert.match(css, /\.wa-task-log::\-webkit-scrollbar\s*\{[^}]*width:\s*12px/s);
    assert.match(css, /\.wa-task-log::\-webkit-scrollbar-thumb\s*\{[^}]*background:/s);
});

test('task view stops ongoing work through the AchillesCLI command bridge', () => {
    const source = fs.readFileSync(
        new URL('../../cli/server/webchat/taskView.js', import.meta.url),
        'utf8',
    );
    const html = fs.readFileSync(
        new URL('../../cli/server/webchat/task-view.html', import.meta.url),
        'utf8',
    );
    assert.match(html, /id="taskStop"/);
    assert.match(source, /task\?\.status === 'ongoing'/);
    assert.match(source, /remoteStatus \|\| ''\).*=== 'cancelling'/);
    assert.match(source, /`\/task stop \$\{taskId\}`/);
    assert.match(source, /Stopping…/);
});

test('generic side panel stops above the floating composer and scrolls its content', () => {
    const css = fs.readFileSync(
        new URL('../../cli/server/webchat/webchat.css', import.meta.url),
        'utf8',
    );
    assert.match(
        css,
        /\.wa-chat-container\.side-panel-open \.wa-side-panel\s*\{[^}]*height:\s*calc\(100% - var\(--wa-floating-composer-space\) \+ 18px\)/s,
    );
    assert.match(
        css,
        /\.wa-side-panel-content\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*auto/s,
    );
});

test('mobile side panel keeps its title and close action below the WebChat header', () => {
    const css = fs.readFileSync(
        new URL('../../cli/server/webchat/webchat.css', import.meta.url),
        'utf8',
    );
    const html = fs.readFileSync(
        new URL('../../cli/server/webchat/chat.html', import.meta.url),
        'utf8',
    );
    assert.match(
        css,
        /@media \(max-width: 900px\)[\s\S]*?\.wa-side-panel\s*\{[^}]*position:\s*absolute !important[^}]*top:\s*0[^}]*height:\s*calc\(100% - var\(--wa-floating-composer-space\) \+ 18px\) !important/s,
    );
    assert.match(
        css,
        /@media \(max-width: 900px\)[\s\S]*?\.wa-chat-container\.side-panel-open \.wa-side-panel-close\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/s,
    );
    assert.match(html, /id="sidePanelClose"[^>]*aria-label="Close"/);
});

test('workspace Markdown and text files are fetched and rendered inside the side panel', async (t) => {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const originalFetch = globalThis.fetch;
    const elements = [];
    const makeElement = (tagName = 'div') => {
        const element = {
            tagName: tagName.toUpperCase(),
            children: [],
            className: '',
            dataset: {},
            style: {},
            _innerHTML: '',
            appendChild(child) {
                this.children.push(child);
                return child;
            },
            addEventListener() {},
            setAttribute() {},
        };
        Object.defineProperty(element, 'innerHTML', {
            get() { return this._innerHTML; },
            set(value) {
                this._innerHTML = String(value);
                this.children = [];
            },
        });
        elements.push(element);
        return element;
    };
    const panelWrapper = makeElement();
    const sidePanel = makeElement();
    sidePanel.querySelector = () => panelWrapper;
    const chatContainer = makeElement();
    chatContainer.classList = { add() {}, remove() {} };
    globalThis.document = { createElement: (tagName) => makeElement(tagName) };
    globalThis.window = { location: { origin: 'http://localhost:8080' } };
    globalThis.fetch = async (url, options) => {
        assert.equal(options.credentials, 'include');
        if (url === '/workspace-files/project/README.md') {
            return { ok: true, text: async () => '# Report' };
        }
        assert.equal(url, '/workspace-files/project/output.log');
        return { ok: true, text: async () => '<unsafe>\nline 2' };
    };
    t.after(() => {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
        globalThis.fetch = originalFetch;
    });

    const api = createSidePanel({
        chatContainer,
        chatArea: null,
        sidePanel,
        sidePanelContent: null,
        sidePanelClose: null,
        sidePanelTitle: null,
        sidePanelResizer: null,
    }, {
        markdown: { render: (text) => `<h1>${text.slice(2)}</h1>` },
        workspaceBase: 'project',
    });
    await api.openWorkspaceFile('/workspace-files/project/README.md', { path: 'README.md' });

    const rendered = panelWrapper.children.at(-1);
    assert.equal(rendered.className, 'wa-side-panel-body wa-workspace-file-text');
    assert.equal(rendered.innerHTML, '<h1>Report</h1>');

    await api.openWorkspaceFile('/workspace-files/project/output.log', { path: 'output.log' });
    const textContainer = panelWrapper.children.at(-1);
    const code = textContainer.children[0].children[0];
    assert.equal(code.textContent, '<unsafe>\nline 2');
    assert.equal(textContainer.innerHTML, '');
});

test('workspace HTML files use a sandboxed iframe', (t) => {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const originalSetTimeout = globalThis.setTimeout;
    let iframe = null;
    const makeElement = (tagName = 'div') => ({
        tagName: tagName.toUpperCase(),
        children: [],
        attributes: new Map(),
        className: '',
        dataset: {},
        style: {},
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        addEventListener() {},
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
    });
    const panelWrapper = makeElement();
    const sidePanel = makeElement();
    sidePanel.querySelector = () => panelWrapper;
    const chatContainer = makeElement();
    chatContainer.classList = { add() {}, remove() {} };
    globalThis.document = {
        createElement(tagName) {
            const element = makeElement(tagName);
            if (tagName === 'iframe') iframe = element;
            return element;
        },
    };
    globalThis.window = { location: { origin: 'http://localhost:8080' } };
    globalThis.setTimeout = () => 0;
    t.after(() => {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
        globalThis.setTimeout = originalSetTimeout;
    });

    const api = createSidePanel({
        chatContainer,
        chatArea: null,
        sidePanel,
        sidePanelContent: null,
        sidePanelClose: null,
        sidePanelTitle: null,
        sidePanelResizer: null,
    }, { markdown: null });
    api.openWorkspaceFile('/workspace-files/project/report.html', { path: 'report.html' });

    assert.ok(iframe);
    assert.equal(iframe.attributes.get('sandbox'), '');
});
