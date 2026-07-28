import assert from 'node:assert/strict';
import test from 'node:test';

import { createTaskViewTransport } from '../../cli/server/webchat/taskViewTransport.js';

const TASK_ID = 'task_313867f2a315ee603892849e';

function createStandaloneWindow() {
    const requests = [];
    const sources = [];
    const storage = new Map();
    class FakeEventSource {
        constructor(url) {
            this.url = url;
            this.listeners = new Map();
            sources.push(this);
        }
        addEventListener(type, listener) { this.listeners.set(type, listener); }
        close() { this.closed = true; }
        emit(type, data) { this.listeners.get(type)?.({ data: JSON.stringify(data) }); }
    }
    const windowRef = {
        location: {
            origin: 'http://localhost:8080',
            pathname: `/webchat/tasks/${TASK_ID}/view`,
            search: '?agent=achilles-cli&forward-envelope=1&dir=%2Fworkspace&sessionId=ignored',
        },
        crypto: { randomUUID: () => 'standalone-tab-id' },
        sessionStorage: {
            getItem: (key) => storage.get(key) || null,
            setItem: (key, value) => storage.set(key, value),
        },
        EventSource: FakeEventSource,
        fetch: async (url, options) => {
            requests.push({ url, options });
            return { ok: true, status: 204 };
        },
        setTimeout: (callback) => callback(),
    };
    windowRef.parent = windowRef;
    return { windowRef, requests, sources };
}

test('standalone task view subscribes to the selected runtime and sends hidden commands', async () => {
    const { windowRef, requests, sources } = createStandaloneWindow();
    const updates = [];
    let opened = 0;
    const transport = createTaskViewTransport({
        windowRef,
        basePath: '/webchat',
        taskId: TASK_ID,
        onOpen: () => { opened += 1; },
        onUpdate: (payload) => updates.push(payload),
    });

    transport.start();
    assert.equal(sources.length, 1);
    assert.match(sources[0].url, /^\/webchat\/stream\?/);
    assert.match(sources[0].url, /agent=achilles-cli/);
    assert.match(sources[0].url, /forward-envelope=1/);
    assert.match(sources[0].url, /dir=%2Fworkspace/);
    assert.match(sources[0].url, /tabId=standalone-tab-id/);
    assert.doesNotMatch(sources[0].url, /sessionId/);

    sources[0].onopen();
    assert.equal(opened, 1);
    sources[0].emit('task-update', {
        event: 'list',
        tasks: [{ id: TASK_ID }, { id: 'task_abcdefabcdefabcdefabcdef' }],
    });
    sources[0].emit('task-update', { event: 'view', task: { id: TASK_ID } });
    assert.equal(updates.length, 2);

    await transport.requestCommand(`/task view ${TASK_ID}`);
    assert.match(requests[0].url, /^\/webchat\/input\?/);
    const envelope = JSON.parse(requests[0].options.body.trim());
    assert.equal(envelope.text, `/task view ${TASK_ID}`);
    assert.equal(envelope.presentation.visible, false);
});

test('standalone task commands retry while the runtime stream is starting', async () => {
    const { windowRef, requests } = createStandaloneWindow();
    const statuses = [409, 409, 204];
    const delays = [];
    windowRef.fetch = async (url, options) => {
        requests.push({ url, options });
        const status = statuses.shift();
        return { ok: status === 204, status };
    };
    windowRef.setTimeout = (callback, delay) => {
        delays.push(delay);
        callback();
    };
    const transport = createTaskViewTransport({ windowRef, taskId: TASK_ID });

    await transport.requestCommand(`/task view ${TASK_ID}`);

    assert.equal(requests.length, 3);
    assert.deepEqual(delays, [100, 250]);
});

test('embedded task view keeps using the same-origin parent bridge', async () => {
    const posted = [];
    const parent = {
        postMessage: (message, origin) => posted.push({ message, origin }),
    };
    const windowRef = {
        parent,
        location: {
            origin: 'http://localhost:8080',
            pathname: `/webchat/tasks/${TASK_ID}/view`,
            search: '?agent=achilles-cli',
        },
    };
    const transport = createTaskViewTransport({ windowRef, taskId: TASK_ID });

    transport.start();
    await transport.requestCommand(`/task view ${TASK_ID}`);

    assert.deepEqual(posted, [{
        message: {
            type: 'webchat-task-command',
            taskId: TASK_ID,
            command: `/task view ${TASK_ID}`,
        },
        origin: 'http://localhost:8080',
    }]);
});
