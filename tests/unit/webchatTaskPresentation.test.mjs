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

test('chat task summary shows metadata and a delegated live-log link without inline expansion', (t) => {
    const originalDocument = globalThis.document;
    const makeElement = (tagName = 'div') => ({
        tagName: tagName.toUpperCase(),
        className: '',
        dataset: {},
        children: [],
        textContent: '',
        append(...children) {
            this.children.push(...children);
        },
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        querySelector() {
            return null;
        },
    });
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
    const dispose = attachTaskSummary({
        bubble,
        taskId: task.id,
        taskController: {
            getTaskViewUrl: (taskId) => `/webchat/tasks/${taskId}/view`,
            subscribe(_taskId, listener) {
                listener({ task, ready: true });
                return () => {};
            },
        },
    });

    const panel = bubble.children[0];
    const [summary, link] = panel.children;
    assert.equal(panel.className, 'wa-task-summary');
    assert.deepEqual(summary.children.map((child) => child.textContent).slice(0, 3), [
        'opencodeAgent',
        'Build project',
        'RUNNING',
    ]);
    assert.equal(link.textContent, 'View task details');
    assert.equal(link.dataset.wcLink, 'true');
    assert.equal(link.dataset.wcTaskId, task.id);
    assert.equal(link.href, `/webchat/tasks/${task.id}/view`);
    assert.equal(panel.children.some((child) => child.tagName === 'BUTTON'), false);
    dispose();
});
