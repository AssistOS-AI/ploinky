import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
    attachTaskSummary,
    mergeTaskLogUpdate,
    parseTaskLog,
    parseTaskLogPresentation,
    renderTaskLog,
    taskDurationSeconds,
    taskStatusPresentation,
    tokenizeTaskLogText,
} from '../../cli/server/webchat/taskPresentation.js';
import { createTaskController } from '../../cli/server/webchat/tasks.js';

const WEBCHAT_CSS = fs.readFileSync(
    new URL('../../cli/server/webchat/webchat.css', import.meta.url),
    'utf8',
);

test('task log updates append in order, ignore duplicates, and request gap recovery', () => {
    const current = { text: 'one', offset: 3 };
    assert.deepEqual(mergeTaskLogUpdate(current, { logAppend: ' two', logOffset: 7 }), {
        text: 'one two',
        offset: 7,
        needsSync: false,
    });
    assert.deepEqual(mergeTaskLogUpdate(current, { logAppend: 'one', logOffset: 3 }), {
        ...current,
        needsSync: false,
    });
    assert.deepEqual(mergeTaskLogUpdate(current, { logAppend: 'late', logOffset: 12 }), {
        ...current,
        needsSync: true,
    });
});

test('task status presentation preserves queued work and maps lifecycle labels', () => {
    assert.equal(taskStatusPresentation({ status: 'ongoing', remoteStatus: 'pending' }).label, 'QUEUED');
    assert.equal(taskStatusPresentation({ status: 'ongoing', remoteStatus: 'running' }).label, 'RUNNING');
    assert.equal(taskStatusPresentation({ status: 'ongoing', remoteStatus: 'cancelling' }).label, 'STOPPING');
    assert.equal(taskStatusPresentation({ status: 'finished' }).label, 'COMPLETED');
    assert.equal(taskStatusPresentation({ status: 'error' }).label, 'FAILED');
    assert.equal(taskStatusPresentation(null).label, 'UNAVAILABLE');
});

test('task duration uses the terminal update time and displays whole seconds', () => {
    assert.equal(taskDurationSeconds({
        status: 'finished',
        createdAt: '2026-07-15T10:00:00.000Z',
        updatedAt: '2026-07-15T10:00:04.900Z',
    }), 4);
});

test('task log parsing strips runner prefixes and keeps stderr visually distinct', () => {
    const parsed = parseTaskLog([
        '[opencodeAgent/execute-task] start projectDir="/work"',
        '[opencode stdout] primary output',
        '[opencode stderr] secondary output',
        '[opencodeAgent/execute-task] exit code=0 durationMs=1234',
        '[opencodeAgent/execute-task] timeout after 300s; sending SIGTERM',
    ].join('\n'));
    assert.deepEqual(parsed, [
        { text: 'primary output', stream: 'stdout' },
        { text: 'secondary output', stream: 'stderr' },
        { text: 'timeout after 300s; sending SIGTERM', stream: 'stderr' },
    ]);
});

test('task log presentation keeps continuation prompts visible before provider output', () => {
    const parsed = parseTaskLog([
        '[Continuation 2]',
        'User: finish the tests',
        '',
        '[worker stdout] Provider output',
    ].join('\n'));
    assert.deepEqual(parsed, [
        { text: 'you> finish the tests', stream: 'stdout' },
        { text: '', stream: 'stdout' },
        { text: 'Provider output', stream: 'stdout' },
    ]);
    assert.equal(
        parseTaskLogPresentation('you> run the focused tests')[0].kind,
        'user-prompt',
    );
});

test('terminal task toast can be dismissed immediately', (t) => {
    const originalDocument = globalThis.document;
    const originalSetInterval = globalThis.setInterval;
    const closeListeners = new Map();
    const taskToast = { hidden: true, textContent: '' };
    const taskToastText = { textContent: '' };
    const taskToastClose = {
        addEventListener(type, listener) {
            closeListeners.set(type, listener);
        },
    };
    globalThis.document = { addEventListener() {} };
    globalThis.setInterval = () => 0;
    t.after(() => {
        globalThis.document = originalDocument;
        globalThis.setInterval = originalSetInterval;
    });

    const controller = createTaskController({
        toEndpoint: (value) => value,
        sendQuickCommand: () => true,
        showBanner() {},
        elements: { taskToast, taskToastText, taskToastClose },
    });
    const task = {
        id: 'task_1234567890abcdef12345678',
        description: 'Run tests',
        status: 'ongoing',
        updatedAt: '2026-07-27T10:00:00.000Z',
    };
    controller.handleUpdate({ event: 'started', task });
    controller.handleUpdate({
        event: 'update',
        task: { ...task, status: 'finished', updatedAt: '2026-07-27T10:00:01.000Z' },
    });

    assert.equal(taskToast.hidden, false);
    assert.equal(taskToastText.textContent, 'Run tests: COMPLETED');
    closeListeners.get('click')();
    assert.equal(taskToast.hidden, true);
});

test('task log presentation marks only the terminal result lines as final', () => {
    const text = 'Read package.json\nRan tests\nFinal answer\n';
    const finalOutputOffset = text.indexOf('Final answer');
    assert.deepEqual(
        parseTaskLogPresentation(text, {
            finalOutputOffset,
            finalOutputLength: 'Final answer\n'.length,
        }).map(({ text: line, tone }) => ({ text: line, tone })),
        [
            { text: 'Read package.json', tone: 'intermediate' },
            { text: 'Ran tests', tone: 'intermediate' },
            { text: 'Final answer', tone: 'final' },
            { text: '', tone: 'intermediate' },
        ],
    );
});

test('task log presentation preserves final results from every continuation turn', () => {
    const text = [
        'First intermediate',
        'First answer',
        '[Continuation 2]',
        'you> continue',
        'Second intermediate',
        'Second answer',
        '',
    ].join('\n');
    const firstOffset = text.indexOf('First answer');
    const secondOffset = text.indexOf('Second answer');
    assert.deepEqual(
        parseTaskLogPresentation(text, {
            turn: 2,
            finalOutputOffset: secondOffset,
            finalOutputLength: 'Second answer'.length,
            finalOutputRanges: [
                { turn: 1, offset: firstOffset, length: 'First answer'.length },
                { turn: 2, offset: secondOffset, length: 'Second answer'.length },
            ],
        }).map(({ text: line, tone }) => ({ text: line, tone })),
        [
            { text: 'First intermediate', tone: 'intermediate' },
            { text: 'First answer', tone: 'final' },
            { text: 'you> continue', tone: 'intermediate' },
            { text: 'Second intermediate', tone: 'intermediate' },
            { text: 'Second answer', tone: 'final' },
            { text: '', tone: 'intermediate' },
        ],
    );
});

test('task log styling mutes intermediate output and emphasizes the final result', () => {
    assert.match(
        WEBCHAT_CSS,
        /\.wa-task-log-line\.is-intermediate\s*\{[^}]*color:\s*var\(--wa-text-muted\)/s,
    );
    assert.match(
        WEBCHAT_CSS,
        /\.wa-task-log-line\.is-final\s*\{[^}]*color:\s*var\(--wa-text-primary\)[^}]*font-weight:\s*600/s,
    );
});

test('task log highlighting preserves text while classifying paths and backticks', () => {
    const text = 'warning: updated src/index.js:12 and `/workspace/output.log`; tests passed';
    const tokens = tokenizeTaskLogText(text);
    assert.equal(tokens.map((token) => token.text).join(''), text);
    assert.deepEqual(
        tokens.filter((token) => token.kind),
        [
            { text: 'src/index.js:12', kind: 'path' },
            { text: '`/workspace/output.log`', kind: 'code' },
        ],
    );
});

test('task log highlighting recognizes absolute paths without treating slash commands as paths', () => {
    const text = 'failed in /home/runner/project/main.py:44; retry with /task view';
    const tokens = tokenizeTaskLogText(text);
    assert.equal(tokens.map((token) => token.text).join(''), text);
    assert.deepEqual(
        tokens.filter((token) => token.kind),
        [
            { text: '/home/runner/project/main.py:44', kind: 'path' },
        ],
    );
});

test('task log token styles remain visual-only spans with no link behavior', () => {
    assert.match(
        WEBCHAT_CSS,
        /\.wa-task-log-token\.is-path\s*\{[^}]*color:\s*#5fbf72[^}]*font-weight:\s*400/s,
    );
    assert.match(
        WEBCHAT_CSS,
        /\.wa-task-log-token\.is-code\s*\{[^}]*color:\s*var\(--wa-accent\)[^}]*\}/s,
    );
    assert.doesNotMatch(WEBCHAT_CSS, /\.wa-task-log-token[^}]*text-decoration:\s*underline/);
    assert.doesNotMatch(WEBCHAT_CSS, /\.wa-task-log-token[^}]*cursor:\s*pointer/);
});

test('task log renderer creates styled spans without anchors or text changes', (t) => {
    const originalDocument = globalThis.document;
    const makeElement = (tagName = 'div') => ({
        tagName: tagName.toUpperCase(),
        children: [],
        className: '',
        textContent: '',
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        replaceChildren(...children) {
            this.children = children;
        },
    });
    globalThis.document = { createElement: (tagName) => makeElement(tagName) };
    t.after(() => { globalThis.document = originalDocument; });

    const container = makeElement();
    const text = 'warning in src/index.js';
    renderTaskLog(container, text);

    const [line] = container.children;
    assert.equal(line.textContent, text);
    assert.equal(line.children.map((child) => child.textContent).join(''), text);
    assert.deepEqual(
        line.children.filter((child) => child.className.includes('wa-task-log-token'))
            .map((child) => [child.textContent, child.className]),
        [
            ['src/index.js', 'wa-task-log-token is-path'],
        ],
    );
    assert.equal(line.children.some((child) => child.tagName === 'A'), false);
});

test('task log renderer turns a safe live-session Markdown link into a side-panel link', (t) => {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const makeElement = (tagName = 'div') => ({
        tagName: tagName.toUpperCase(),
        children: [],
        className: '',
        dataset: {},
        textContent: '',
        appendChild(child) { this.children.push(child); return child; },
        replaceChildren(...children) { this.children = children; },
    });
    globalThis.document = { createElement: (tagName) => makeElement(tagName) };
    globalThis.window = { location: { origin: 'http://localhost:8080' } };
    t.after(() => {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
    });

    const container = makeElement();
    renderTaskLog(container, 'Robot started. [Open live desktop](/robot/session/)');

    const link = container.children[0].children.find((child) => child.tagName === 'A');
    assert.equal(link.textContent, 'Open live desktop');
    assert.equal(link.href, 'http://localhost:8080/robot/session/');
    assert.equal(link.dataset.wcLink, 'true');
});

test('task log renderer leaves unsafe Markdown URLs inert', (t) => {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const makeElement = (tagName = 'div') => ({
        tagName: tagName.toUpperCase(),
        children: [],
        className: '',
        dataset: {},
        textContent: '',
        appendChild(child) { this.children.push(child); return child; },
        replaceChildren(...children) { this.children = children; },
    });
    globalThis.document = { createElement: (tagName) => makeElement(tagName) };
    globalThis.window = { location: { origin: 'http://localhost:8080' } };
    t.after(() => {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
    });

    const container = makeElement();
    renderTaskLog(container, '[Open session](javascript:alert(1))');

    assert.equal(container.children[0].children.some((child) => child.tagName === 'A'), false);
});

test('chat task summary streams inline logs and collapses to its metadata header', async (t) => {
    const originalDocument = globalThis.document;
    const makeElement = (tagName = 'div') => {
        const attributes = new Map();
        const listeners = new Map();
        const element = {
            tagName: tagName.toUpperCase(),
            style: {},
            className: '',
            dataset: {},
            children: [],
            textContent: '',
            hidden: false,
            scrollHeight: 100,
            scrollTop: 0,
            clientHeight: 60,
            append(...children) { this.children.push(...children); },
            appendChild(child) {
                this.children.push(child);
                return child;
            },
            replaceChildren(...children) { this.children = children; },
            querySelector() { return null; },
            setAttribute(name, value) { attributes.set(name, String(value)); },
            getAttribute(name) { return attributes.get(name); },
            addEventListener(type, listener) { listeners.set(type, listener); },
        };
        element.classList = {
            toggle(name, force) {
                const names = new Set(element.className.split(/\s+/).filter(Boolean));
                const enabled = force === undefined ? !names.has(name) : force;
                if (enabled) names.add(name);
                else names.delete(name);
                element.className = [...names].join(' ');
                return enabled;
            },
        };
        return element;
    };
    globalThis.document = { createElement: (tagName) => makeElement(tagName) };
    t.after(() => { globalThis.document = originalDocument; });
    const bubble = makeElement();
    const task = {
        id: 'task_1234567890abcdef12345678',
        targetAgent: 'opencodeAgent',
        description: 'Build project',
        status: 'ongoing',
        remoteStatus: 'running',
        createdAt: new Date().toISOString(),
    };
    let subscriber = null;
    let loadRequests = 0;
    const actions = [];
    const dispose = attachTaskSummary({
        bubble,
        taskId: task.id,
        taskController: {
            getTaskViewUrl: (taskId) => `/webchat/tasks/${taskId}/view`,
            subscribe(_taskId, listener) {
                subscriber = listener;
                listener({ task, ready: true, log: 'first message\n', logLoaded: true });
                return () => {};
            },
            async loadLog() { loadRequests += 1; },
            stopTask(taskId) { actions.push(['stop', taskId]); return true; },
            resumeTask(taskId) { actions.push(['resume', taskId]); return true; },
            continueTask(taskId, prompt) { actions.push(['message', taskId, prompt]); return true; },
        },
    });

    const panel = bubble.children[0];
    const [summary, body] = panel.children;
    const [log, actionRow, actionError, composer] = body.children;
    const [link, actionButton] = actionRow.children;
    assert.equal(panel.className, 'wa-task-summary is-expanded');
    assert.equal(summary.tagName, 'BUTTON');
    assert.deepEqual(summary.children.map((child) => child.textContent).slice(0, 3), [
        'opencodeAgent',
        'Build project',
        'RUNNING',
    ]);
    assert.equal(log.children[0].textContent, 'first message');
    assert.equal(link.textContent, 'Open Task');
    assert.equal(link.dataset.wcLink, 'true');
    assert.equal(link.dataset.wcTaskId, task.id);
    assert.equal(link.href, `/webchat/tasks/${task.id}/view`);
    assert.equal(actionButton.hidden, false);
    assert.equal(actionButton.textContent, 'Stop');
    assert.equal(loadRequests, 1);

    actionButton.onclick({ preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(actions, [['stop', task.id]]);
    assert.equal(actionButton.textContent, 'Stopping…');

    subscriber({
        task: {
            ...task,
            remoteStatus: 'cancelled',
            status: 'stopped',
            continuation: { handle: 'continuation_handle_1' },
        },
        ready: true,
        log: 'first message\n',
        logLoaded: true,
    });
    assert.equal(actionButton.textContent, 'Resume');
    actionButton.onclick({ preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(actions, [['stop', task.id], ['resume', task.id]]);
    assert.equal(actionButton.textContent, 'Resuming…');

    subscriber({
        task: {
            ...task,
            remoteStatus: 'cancelled',
            status: 'stopped',
            continuation: { handle: 'continuation_handle_1' },
        },
        ready: true,
        log: 'first message\n',
        logLoaded: true,
        actionEvent: true,
        action: 'resume',
        actionOk: false,
        actionError: 'Resume was denied.',
    });
    assert.equal(actionButton.textContent, 'Resume');
    assert.equal(actionButton.disabled, false);
    assert.equal(actionError.hidden, false);
    assert.equal(actionError.textContent, 'Resume was denied.');

    actionButton.onclick({ preventDefault() {}, stopPropagation() {} });
    assert.deepEqual(actions.at(-1), ['resume', task.id]);

    subscriber({ task: { ...task, turn: 2 }, ready: true, log: 'first message\n', logLoaded: true });
    assert.equal(actionButton.textContent, 'Stop');
    assert.equal(composer.hidden, true);
    const liveTask = { ...task, continuation: { handle: 'continuation_handle_2', messageToolName: 'send-input' } };
    subscriber({ task: liveTask, ready: true, log: 'first message\n', logLoaded: true });
    assert.equal(composer.hidden, false);
    const [input, send] = composer.children;
    assert.equal(input.style.height, '64px');
    input.value = 'check the screen';
    input.scrollHeight = 110;
    input.oninput();
    assert.equal(input.style.height, '112px');
    assert.equal(input.style.overflowY, 'hidden');
    input.scrollHeight = 240;
    input.oninput();
    assert.equal(input.style.height, '180px');
    assert.equal(input.style.overflowY, 'auto');
    input.scrollHeight = 80;
    input.scrollTop = 50;
    input.oninput();
    assert.equal(input.style.height, '82px');
    assert.equal(input.style.overflowY, 'hidden');
    assert.equal(input.scrollTop, 0);
    composer.onsubmit({ preventDefault() {} });
    assert.deepEqual(actions.at(-1), ['message', task.id, 'check the screen']);
    assert.equal(send.textContent, 'Sending…');
    subscriber({ task: liveTask, ready: true, log: 'first message\n', logLoaded: true,
        actionEvent: true, action: 'continue', actionOk: true });
    assert.equal(input.value, '');
    assert.equal(input.style.height, '64px');
    assert.equal(send.disabled, false);

    summary.onclick();
    assert.equal(body.hidden, true);
    assert.equal(summary.getAttribute('aria-expanded'), 'false');
    assert.equal(summary.children.at(-1).textContent, '▸');

    subscriber({ task: { ...task, remoteStatus: 'completed', status: 'finished' }, ready: true, log: 'first message\nsecond message\n', logLoaded: true });
    assert.equal(log.children[1].textContent, 'second message');
    summary.onclick();
    assert.equal(body.hidden, false);
    assert.equal(summary.getAttribute('aria-expanded'), 'true');
    dispose();
});

test('inline task composer uses theme colors and visible interaction states', () => {
    assert.match(WEBCHAT_CSS, /\.wa-task-composer textarea\s*\{[^}]*resize:\s*none[^}]*overflow-y:\s*hidden/s);
    assert.match(WEBCHAT_CSS, /\.wa-task-composer textarea\s*\{[^}]*background:\s*var\(--wa-bg-input\)[^}]*color:\s*var\(--wa-text-primary\)/s);
    assert.match(WEBCHAT_CSS, /\.wa-task-composer textarea:focus\s*\{[^}]*border-color:\s*var\(--wa-accent\)/s);
    assert.match(WEBCHAT_CSS, /\.wa-task-composer button\s*\{[^}]*background:\s*var\(--wa-accent\)/s);
    assert.match(WEBCHAT_CSS, /\.wa-task-composer button:disabled\s*\{[^}]*cursor:\s*progress/s);
    assert.match(WEBCHAT_CSS, /\.wa-task-composer\[hidden\]\s*\{[^}]*display:\s*none/s);
    assert.match(WEBCHAT_CSS, /@media \(max-width: 480px\)\s*\{\s*\.wa-task-composer\s*\{[^}]*flex-wrap:\s*wrap/s);
});

test('inline task logs grow to a maximum height before scrolling', () => {
    assert.match(
        WEBCHAT_CSS,
        /\.wa-task-summary-log\s*\{[^}]*max-height:\s*280px[^}]*overflow-y:\s*auto/s,
    );
    assert.match(WEBCHAT_CSS, /\.wa-task-summary-body\[hidden\]\s*\{[^}]*display:\s*none/s);
});

test('task controller assembles chunked log snapshots for inline subscribers', (t) => {
    const originalDocument = globalThis.document;
    const originalSetInterval = globalThis.setInterval;
    globalThis.document = { addEventListener() {} };
    globalThis.setInterval = () => 0;
    t.after(() => {
        globalThis.document = originalDocument;
        globalThis.setInterval = originalSetInterval;
    });
    const controller = createTaskController({
        toEndpoint: (value) => value,
        sendQuickCommand: () => true,
        showBanner() {},
        elements: {},
    });
    const task = {
        id: 'task_1234567890abcdef12345678',
        targetAgent: 'roboTeamAgent',
        description: 'Inspect the desktop',
        status: 'ongoing',
        remoteStatus: 'running',
        createdAt: '2026-07-27T10:00:00.000Z',
        updatedAt: '2026-07-27T10:00:01.000Z',
    };
    let latest = null;
    controller.subscribe(task.id, (value) => { latest = value; });
    controller.handleUpdate({ event: 'started', task });
    controller.handleUpdate({
        event: 'view',
        task,
        log: { text: '', nextOffset: 11 },
        logChunk: { phase: 'start', count: 2, nextOffset: 11 },
    });
    controller.handleUpdate({
        event: 'view-log-chunk',
        task,
        logChunk: { phase: 'chunk', index: 0, count: 2, text: 'hello ', nextOffset: 11 },
    });
    controller.handleUpdate({
        event: 'view-log-chunk',
        task,
        logChunk: { phase: 'chunk', index: 1, count: 2, text: 'world', nextOffset: 11 },
    });
    assert.equal(latest.logLoaded, true);
    assert.equal(latest.log, 'hello world');

    controller.handleUpdate({
        event: 'action',
        action: 'resume',
        ok: false,
        error: 'Resume was denied.',
        task: { ...task, status: 'stopped', remoteStatus: 'cancelled' },
    });
    assert.equal(latest.actionEvent, true);
    assert.equal(latest.action, 'resume');
    assert.equal(latest.actionOk, false);
    assert.equal(latest.actionError, 'Resume was denied.');
});
