import assert from 'node:assert/strict';
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
