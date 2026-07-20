import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { __testables as taskRouteTestables } from '../../cli/server/handlers/webchat/taskRoutes.js';
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

test('task view exposes continuation only through the same local task route', () => {
    const source = fs.readFileSync(
        new URL('../../cli/server/webchat/taskView.js', import.meta.url),
        'utf8',
    );
    const html = fs.readFileSync(
        new URL('../../cli/server/webchat/task-view.html', import.meta.url),
        'utf8',
    );
    assert.match(html, /id="taskContinuationInput"/);
    assert.match(source, /tasks\/\$\{encodeURIComponent\(taskId\)\}\/continue/);
    assert.match(source, /TERMINAL_STATUSES\.has\(task\?\.status\)/);
    assert.match(source, /applyUpdate\(payload\)/);
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

test('task continuation activates a missing provider globally and waits for readiness', async () => {
    let route = null;
    const activations = [];
    const readiness = [];
    const resolved = await taskRouteTestables.ensureContinuationAgentRoute('workerAgent', {
        resolveRoute() {
            return route;
        },
        activateAgent(agent) {
            activations.push({ agent, mode: 'global' });
            route = {
                agentName: 'workerAgent',
                route: { relay: { kind: 'container-exec-stdio' }, primaryService: { port: 7000 } },
            };
            return {
                repoName: 'workers',
                shortAgentName: 'workerAgent',
                runMode: 'global',
            };
        },
        readManifest() {
            return { readiness: { protocol: 'mcp' } };
        },
        async waitUntilReady(agentRoute, options) {
            readiness.push({ agentRoute, options });
            return true;
        },
    });

    assert.equal(resolved, route);
    assert.deepEqual(activations, [{ agent: 'workerAgent', mode: 'global' }]);
    assert.equal(readiness.length, 1);
    assert.equal(readiness[0].options.protocol, 'mcp');
    assert.equal(readiness[0].options.timeoutMs, 15_000);
});

test('concurrent task continuations share one provider activation', async () => {
    let route = null;
    let activationCount = 0;
    let releaseActivation;
    const activationGate = new Promise((resolve) => {
        releaseActivation = resolve;
    });
    const options = {
        resolveRoute() {
            return route;
        },
        async activateAgent() {
            activationCount += 1;
            await activationGate;
            route = {
                agentName: 'sharedWorker',
                route: { relay: { kind: 'container-exec-stdio' }, primaryService: { port: 7000 } },
            };
            return {
                repoName: 'workers',
                shortAgentName: 'sharedWorker',
                runMode: 'global',
            };
        },
        readManifest() {
            return { readiness: { protocol: 'mcp' } };
        },
        async waitUntilReady() {
            return true;
        },
    };

    const first = taskRouteTestables.ensureContinuationAgentRoute('sharedWorker', options);
    const second = taskRouteTestables.ensureContinuationAgentRoute('sharedWorker', options);
    releaseActivation();
    const [firstRoute, secondRoute] = await Promise.all([first, second]);

    assert.equal(activationCount, 1);
    assert.equal(firstRoute, route);
    assert.equal(secondRoute, route);
});

test('generic side panel stops above the floating composer and scrolls its content', () => {
    const css = fs.readFileSync(
        new URL('../../cli/server/webchat/webchat.css', import.meta.url),
        'utf8',
    );
    assert.match(
        css,
        /\.wa-chat-container\.side-panel-open \.wa-side-panel\s*\{[^}]*height:\s*calc\(100% - var\(--wa-floating-composer-space\)\)/s,
    );
    assert.match(
        css,
        /\.wa-side-panel-content\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*auto/s,
    );
});
