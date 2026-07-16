import assert from 'node:assert/strict';
import test from 'node:test';

import {
    attachTaskSummary,
    mergeTaskLogUpdate,
    parseTaskLog,
    taskDurationSeconds,
    taskStatusPresentation,
} from '../../cli/server/webchat/taskPresentation.js';

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
    assert.equal(link.textContent, 'View live logs');
    assert.equal(link.dataset.wcLink, 'true');
    assert.equal(link.dataset.wcTaskId, task.id);
    assert.equal(link.href, `/webchat/tasks/${task.id}/view`);
    assert.equal(panel.children.some((child) => child.tagName === 'BUTTON'), false);
    dispose();
});
