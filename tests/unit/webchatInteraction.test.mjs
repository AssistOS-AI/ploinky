import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { handleRuntimeRoute } from '../../cli/server/handlers/webchat/runtimeRoutes.js';
import {
    buildRuntimeKey,
    parseWebchatInteraction,
    routeWorkspaceRuntimeOutput,
} from '../../cli/server/handlers/webchat/runtimeState.js';
import { createInteractionPrompt } from '../../cli/server/webchat/interactionPrompt.js';
import { __testables as networkTestables } from '../../cli/server/webchat/network.js';

function approvalEnvelope(id = 'approval_12345678') {
    return {
        __webchatInteraction: 1,
        version: 1,
        id,
        kind: 'approval',
        title: 'Bash approval required',
        message: 'The Bash tool requests permission to execute this command.',
        detail: '$ ls -la',
        options: [
            { id: 'always-allow', label: 'Always approve' },
            { id: 'allow', label: 'Allow' },
            { id: 'deny', label: 'Deny', tone: 'danger' },
        ],
        defaultOptionId: 'always-allow',
    };
}

test('interaction envelopes become SSE state without entering conversation history', (t) => {
    const workspaceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-interaction-'));
    t.after(() => fs.rmSync(workspaceDirectory, { recursive: true, force: true }));
    const writes = [];
    const tab = {
        workspaceDirectory,
        subscribers: new Map([['client', { res: { write: (value) => writes.push(value) } }]]),
        taskProtocolBuffer: '',
    };
    const appState = { runtimes: new Map([['runtime', tab]]) };
    const serialized = JSON.stringify(approvalEnvelope());

    routeWorkspaceRuntimeOutput(appState, tab, serialized.slice(0, 30));
    routeWorkspaceRuntimeOutput(appState, tab, `${serialized.slice(30)}\n`);

    assert.equal(tab.pendingInteraction.id, 'approval_12345678');
    assert.match(writes.join(''), /event: interaction-request/);
    assert.equal(fs.existsSync(path.join(workspaceDirectory, '.achilles-cli')), false);
    assert.equal(networkTestables.parseInteractionPayload(JSON.stringify(tab.pendingInteraction)).defaultOptionId, 'always-allow');
});

test('interaction validation rejects malformed options and preserves the requested default', () => {
    const parsed = parseWebchatInteraction(approvalEnvelope());
    assert.equal(parsed.defaultOptionId, 'always-allow');
    assert.deepEqual(parsed.options.map((option) => option.id), ['always-allow', 'allow', 'deny']);
    assert.equal(parseWebchatInteraction({ ...approvalEnvelope(), options: [] }), undefined);
    assert.equal(parseWebchatInteraction({ ...approvalEnvelope(), id: '../bad' }), undefined);
});

test('an EventSource reconnect receives the pending interaction snapshot', (t) => {
    const workspaceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-interaction-reconnect-'));
    t.after(() => fs.rmSync(workspaceDirectory, { recursive: true, force: true }));
    const effectiveConfig = { agentName: 'demo-agent' };
    const runtimeKey = buildRuntimeKey(workspaceDirectory, effectiveConfig, '');
    const sid = 'browser-session';
    const tab = {
        tty: {},
        subscribers: new Map(),
        workspaceDirectory,
        pendingInteraction: parseWebchatInteraction(approvalEnvelope()),
    };
    const appState = {
        runtimes: new Map([[runtimeKey, tab]]),
        sessions: new Map([[sid, { tabs: new Map() }]]),
    };
    const req = new EventEmitter();
    req.headers = { cookie: `webchat_sid=${sid}` };
    const writes = [];
    const res = {
        writeHead(status) { assert.equal(status, 200); },
        write(value) { writes.push(value); },
        end() {},
    };

    handleRuntimeRoute({
        pathname: '/stream',
        req,
        res,
        parsedUrl: new URL('http://localhost/stream?tabId=tab-1'),
        appState,
        workspaceDirectory,
        effectiveConfig,
        agentQuery: '',
    });

    assert.match(writes.join(''), /event: interaction-request/);
    assert.match(writes.join(''), /Always approve/);
    req.emit('close');
    if (tab.cleanupTimer) clearTimeout(tab.cleanupTimer);
});

test('authenticated interaction responses use the control channel and reject replay', (t) => {
    const workspaceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-interaction-response-'));
    t.after(() => fs.rmSync(workspaceDirectory, { recursive: true, force: true }));
    const effectiveConfig = { agentName: 'demo-agent' };
    const runtimeKey = buildRuntimeKey(workspaceDirectory, effectiveConfig, '');
    const sid = 'browser-session';
    const tabId = 'tab-1';
    const ttyWrites = [];
    const sseWrites = [];
    const tab = {
        tty: { write: (value) => ttyWrites.push(value) },
        workspaceDirectory,
        pendingInteraction: parseWebchatInteraction(approvalEnvelope()),
        subscribers: new Map([['client', { sid, tabId, res: { write: (value) => sseWrites.push(value) } }]]),
    };
    const appState = {
        runtimes: new Map([[runtimeKey, tab]]),
        sessions: new Map([[sid, { tabs: new Map() }]]),
    };

    const foreign = postInteraction({
        appState,
        workspaceDirectory,
        effectiveConfig,
        sid: 'foreign-session',
        tabId,
    });
    assert.equal(foreign.status, 409);
    assert.equal(ttyWrites.length, 0);

    const unknownOption = postInteraction({
        appState,
        workspaceDirectory,
        effectiveConfig,
        sid,
        tabId,
        optionId: 'not-declared',
    });
    assert.equal(unknownOption.status, 400);
    assert.equal(ttyWrites.length, 0);

    const blockedInput = postInput({ appState, workspaceDirectory, effectiveConfig, tabId });
    assert.equal(blockedInput.status, 409);
    assert.equal(ttyWrites.length, 0);

    const first = postInteraction({ appState, workspaceDirectory, effectiveConfig, sid, tabId });
    assert.equal(first.status, 204);
    assert.match(ttyWrites[0], /"__webchatInteractionResponse":1/);
    assert.match(ttyWrites[0], /"optionId":"always-allow"/);
    assert.equal(tab.pendingInteraction, null);
    assert.match(sseWrites.join(''), /event: interaction-resolved/);

    const replay = postInteraction({ appState, workspaceDirectory, effectiveConfig, sid, tabId });
    assert.equal(replay.status, 409);
});

test('approval selector starts on Always approve and supports arrow plus Enter', async () => {
    const originalDocument = globalThis.document;
    const submitted = [];
    const activeStates = [];
    const dom = createPromptDom();
    globalThis.document = dom.document;
    try {
        const prompt = createInteractionPrompt(dom.elements, {
            onSubmit: (interactionId, optionId) => submitted.push({ interactionId, optionId }),
            onActiveChange: (active) => activeStates.push(active),
        });
        prompt.show(parseWebchatInteraction(approvalEnvelope()));
        assert.equal(prompt.selectedOptionId, 'always-allow');
        prompt.handleKeydown(keyEvent('ArrowDown'));
        assert.equal(prompt.selectedOptionId, 'allow');
        prompt.handleKeydown(keyEvent('ArrowUp'));
        assert.equal(prompt.selectedOptionId, 'always-allow');
        prompt.handleKeydown(keyEvent('Enter'));
        await Promise.resolve();
        assert.deepEqual(submitted, [{ interactionId: 'approval_12345678', optionId: 'always-allow' }]);
        prompt.resolve({ id: 'approval_12345678' });
        assert.deepEqual(activeStates, [true, false]);
        assert.equal(dom.elements.root.hidden, true);
    } finally {
        globalThis.document = originalDocument;
    }
});

function postInteraction({
    appState,
    workspaceDirectory,
    effectiveConfig,
    sid,
    tabId,
    interactionId = 'approval_12345678',
    optionId = 'always-allow',
}) {
    const req = new EventEmitter();
    req.method = 'POST';
    req.headers = { cookie: `webchat_sid=${sid}` };
    const result = { status: null, body: '' };
    const res = {
        writeHead(status) { result.status = status; },
        end(body = '') { result.body = String(body); },
    };
    handleRuntimeRoute({
        pathname: '/interaction',
        req,
        res,
        parsedUrl: new URL(`http://localhost/interaction?tabId=${tabId}`),
        appState,
        workspaceDirectory,
        effectiveConfig,
        agentQuery: '',
    });
    req.emit('data', JSON.stringify({ interactionId, optionId }));
    req.emit('end');
    return result;
}

function postInput({ appState, workspaceDirectory, effectiveConfig, tabId }) {
    const req = new EventEmitter();
    req.method = 'POST';
    req.headers = {};
    const result = { status: null, body: '' };
    const res = {
        writeHead(status) { result.status = status; },
        end(body = '') { result.body = String(body); },
    };
    handleRuntimeRoute({
        pathname: '/input',
        req,
        res,
        parsedUrl: new URL(`http://localhost/input?tabId=${tabId}`),
        appState,
        workspaceDirectory,
        effectiveConfig,
        agentQuery: '',
    });
    return result;
}

function keyEvent(key) {
    return { key, preventDefault() {} };
}

function createPromptDom() {
    const makeClassList = () => {
        const values = new Set();
        return {
            add: (...names) => names.forEach((name) => values.add(name)),
            remove: (...names) => names.forEach((name) => values.delete(name)),
            contains: (name) => values.has(name),
        };
    };
    const makeElement = () => {
        const listeners = new Map();
        return {
            children: [],
            classList: makeClassList(),
            hidden: false,
            textContent: '',
            setAttribute() {},
            addEventListener(type, handler) { listeners.set(type, handler); },
            appendChild(child) { this.children.push(child); },
            replaceChildren(...children) { this.children = children; },
            focus() {},
        };
    };
    const root = makeElement();
    const title = makeElement();
    const message = makeElement();
    const detail = makeElement();
    const options = makeElement();
    return {
        document: { createElement: makeElement },
        elements: { root, title, message, detail, options },
    };
}
