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

function logFixture(t) {
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const makeElement = () => ({ children: [], className: '', innerHTML: '', textContent: '',
        appendChild(child) { this.children.push(child); },
        replaceChildren(...children) { this.children = children; } });
    globalThis.document = { createElement: makeElement };
    globalThis.window = { location: { origin: 'https://workspace.example' } };
    t.after(() => { globalThis.document = originalDocument; globalThis.window = originalWindow; });
    return makeElement();
}

test('task logs render multiline Markdown using the final-message renderer', t => {
    const container = logFixture(t);
    const text = '# Work\n\n**Done** in src/app.js with `code`.\n\n- first\n- second\n\n| Item | State |\n| --- | --- |\n| Test | Passed |\n\n```js\nconst x = 1;\nconsole.log(x);\n```';
    renderTaskLog(container, text);
    assert.equal(container.children.length, 1);
    const html = container.children[0].innerHTML;
    assert.match(html, /<h1>Work<\/h1>/);
    assert.match(html, /<strong>Done<\/strong> in src\/app.js/);
    assert.match(html, /<code>code<\/code>/);
    assert.match(html, /<ul><li>first<\/li><li>second<\/li><\/ul>/);
    assert.match(html, /<table/);
    assert.match(html, /<pre><code data-lang="js">const x = 1;\nconsole.log\(x\);<\/code><\/pre>/);
    assert.doesNotMatch(html, /log-token|is-path/);
    assert.equal(html, globalThis.webchatMarkdown.render(text));
});

test('user input renders as its own Markdown block between assistant outputs', t => {
    const container = logFixture(t);
    renderTaskLog(container, 'Previous output\nyou> Continue where you left off\nyou> **Keep** the same scope\n\nWorking again');
    assert.equal(container.children.length, 3);
    assert.match(container.children[1].className, /is-user-prompt/);
    assert.match(container.children[1].innerHTML, /Continue where you left off/);
    assert.match(container.children[1].innerHTML, /<strong>Keep<\/strong>/);
    assert.doesNotMatch(container.children[0].className, /is-user-prompt/);
    assert.doesNotMatch(container.children[2].className, /is-user-prompt/);
});

test('stream updates reparse a complete code block while retaining final-output boundaries', t => {
    const container = logFixture(t);
    const start = '[worker stdout] # Progress\n[worker stdout] ```js\n[worker stdout] const value = 1;';
    renderTaskLog(container, start);
    const text = start + '\n[worker stdout] ```\n**Finished**';
    renderTaskLog(container, text, '', { finalOutputOffset: text.indexOf('**Finished**'), finalOutputLength: 12 });
    assert.equal(container.children.length, 2);
    assert.match(container.children[0].innerHTML, /<pre><code data-lang="js">const value = 1;<\/code><\/pre>/);
    assert.match(container.children[1].innerHTML, /<strong>Finished<\/strong>/);
    assert.match(container.children[1].className, /is-final/);
    assert.doesNotMatch(container.children[0].innerHTML, /worker stdout/);
});

test('Markdown logs escape HTML, reject executable links and preserve code literally', t => {
    const container = logFixture(t);
    renderTaskLog(container, '<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[unsafe](javascript:alert(1))\n\n```html\n<img src=x>\n**literal**\n```');
    const html = container.children[0].innerHTML;
    assert.doesNotMatch(html, /<script|<img|href="javascript:/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&lt;img src=x&gt;\n\*\*literal\*\*/);
});

test('Markdown task links retain Router origin and side-panel metadata', t => {
    const container = logFixture(t);
    renderTaskLog(container, '[Open live desktop](/robot/session/)');
    const html = container.children[0].innerHTML;
    assert.match(html, /href="https:\/\/workspace.example\/robot\/session\/"/);
    assert.match(html, /data-wc-link="true"/);
    assert.match(html, /rel="noopener noreferrer"/);
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
            removeAttribute(name) { attributes.delete(name); delete this[name]; },
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

    t.after(dispose);
    const [summary, body] = bubble.children[0].children;
    const [link, logs, live] = body.children[0].children;
    assert.equal(body.hidden, false);
    assert.equal(link.textContent, 'View Task Details');
    assert.equal(link.dataset.wcTaskId, task.id);
    assert.equal(logs.hidden, true);
    assert.equal(loadRequests, 0, 'inline cards must not request task logs');
    assert.equal(body.children.length, 1, 'no inline log or composer');
    assert.equal(summary.onclick, undefined);
    assert.equal(summary.children.length, 4);
    assert.equal(body.hidden, false);
    subscriber({ task: { ...task, robotName: 'analyst', liveSession: { mode: 'browser', url: '/example/session/' } }, ready: true });
    assert.equal(summary.children[0].textContent, 'Robot: analyst');
    assert.equal(live.hidden, false);
    assert.equal(live.textContent, 'Open live browser');
    assert.equal(live.href, '/example/session/');
    subscriber({ task: { ...task, liveSession: { mode: 'browser', url: 'javascript:alert(1)' } }, ready: true });
    assert.equal(live.hidden, true);
    const flowUrl = '/base-agent-additional-server/roboTeamAgent/3001/roboflow?flowId=flow_603070ca4a29b08bff4a3141';
    subscriber({ task: { ...task, details: { url: flowUrl, label: 'Open workflow page', logsLabel: 'View workflow logs' } }, ready: true });
    assert.equal(link.href, flowUrl);
    assert.equal(link.textContent, 'Open workflow page');
    assert.equal(link.dataset.wcTaskId, undefined);
    assert.equal(logs.hidden, false);
    assert.equal(logs.href, `/webchat/tasks/${task.id}/view`);
    assert.equal(logs.textContent, 'View workflow logs');
    subscriber({ task: { ...task, details: { url: 'https://evil.example/' } }, ready: true });
    assert.equal(link.textContent, 'View Task Details');
    assert.equal(link.href, `/webchat/tasks/${task.id}/view`);
    assert.equal(logs.hidden, true);
    assert.deepEqual(actions, []);

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
