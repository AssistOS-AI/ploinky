import assert from 'node:assert/strict';
import test from 'node:test';

import { createTaskViewTransport } from '../../cli/server/webchat/taskViewTransport.js';

const TASK_ID = 'task_313867f2a315ee603892849e';

function createStandaloneWindow() {
    const requests = [];
    const sources = [];
    const storage = new Map();
    const listeners = new Map();
    const uuids = ['standalone-tab-id', 'standalone-page-id'];
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
        crypto: { randomUUID: () => uuids.shift() || 'next-page-id' },
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
        addEventListener: (type, listener) => listeners.set(type, listener),
    };
    windowRef.parent = windowRef;
    return { windowRef, requests, sources, listeners };
}

test('standalone task view subscribes to the selected runtime and sends hidden commands', async () => {
    const { windowRef, requests, sources } = createStandaloneWindow();
    const updates = [];
    const interactions = [];
    const resolutions = [];
    let opened = 0;
    const transport = createTaskViewTransport({
        windowRef,
        basePath: '/webchat',
        taskId: TASK_ID,
        onOpen: () => { opened += 1; },
        onUpdate: (payload) => updates.push(payload),
        onInteractionRequest: (payload) => interactions.push(payload),
        onInteractionResolved: (payload) => resolutions.push(payload),
    });

    transport.start();
    assert.equal(sources.length, 1);
    assert.match(sources[0].url, /^\/webchat\/stream\?/);
    assert.match(sources[0].url, /agent=achilles-cli/);
    assert.match(sources[0].url, /forward-envelope=1/);
    assert.match(sources[0].url, /dir=%2Fworkspace/);
    assert.match(sources[0].url, /tabId=standalone-tab-id/);
    assert.match(sources[0].url, /pageInstanceId=standalone-page-id/);
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

    sources[0].emit('interaction-request', {
        id: 'task_control_other',
        targetTabId: 'another-tab',
        options: [],
    });
    sources[0].emit('interaction-request', {
        id: 'task_control_12345678',
        targetTabId: 'standalone-tab-id',
        targetPageInstanceId: 'standalone-page-id',
        options: [],
    });
    sources[0].emit('interaction-resolved', { id: 'task_control_12345678', status: 'submitted' });
    assert.deepEqual(interactions, [{
        id: 'task_control_12345678',
        targetTabId: 'standalone-tab-id',
        targetPageInstanceId: 'standalone-page-id',
        options: [],
    }]);
    assert.deepEqual(resolutions, [{ id: 'task_control_12345678', status: 'submitted' }]);
    await transport.sendInteractionResponse('task_control_12345678', 'choice_0');
    assert.match(requests[1].url, /^\/webchat\/interaction\?/);
    assert.deepEqual(JSON.parse(requests[1].options.body), {
        interactionId: 'task_control_12345678',
        optionId: 'choice_0',
    });
});

test('standalone task refresh sends a keepalive cancellation for pending login input', async () => {
    const { windowRef, requests, sources, listeners } = createStandaloneWindow();
    const transport = createTaskViewTransport({ windowRef, taskId: TASK_ID });
    transport.start();
    sources[0].emit('interaction-request', {
        id: 'task_control_12345678',
        targetTabId: 'standalone-tab-id',
        targetPageInstanceId: 'standalone-page-id',
        options: [],
        input: { type: 'secret', maxLength: 1024 },
    });

    listeners.get('pagehide')?.({ persisted: false });
    await Promise.resolve();

    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /interaction/);
    assert.equal(requests[0].options.keepalive, true);
    assert.deepEqual(JSON.parse(requests[0].options.body), {
        interactionId: 'task_control_12345678',
        cancelled: true,
    });
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
    await transport.sendInteractionResponse('task_control_12345678', 'choice_0');
    await transport.sendInteractionCancel('task_control_87654321');

    assert.deepEqual(posted, [{
        message: {
            type: 'webchat-task-command',
            taskId: TASK_ID,
            command: `/task view ${TASK_ID}`,
        },
        origin: 'http://localhost:8080',
    }, {
        message: {
            type: 'webchat-task-interaction-response',
            taskId: TASK_ID,
            interactionId: 'task_control_12345678',
            optionId: 'choice_0',
        },
        origin: 'http://localhost:8080',
    }, {
        message: {
            type: 'webchat-task-interaction-response',
            taskId: TASK_ID,
            interactionId: 'task_control_87654321',
            cancelled: true,
        },
        origin: 'http://localhost:8080',
    }]);
});
