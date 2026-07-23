import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import {
    buildRuntimeKey,
    parseWebchatRuntimeState,
    routeWorkspaceRuntimeOutput,
    serializeRuntimeStateSseEvent,
} from '../../cli/server/handlers/webchat/runtimeState.js';
import { handleRuntimeRoute } from '../../cli/server/handlers/webchat/runtimeRoutes.js';
import {
    appendSessionMessage,
    ensureCurrentSession,
    loadSession,
} from '../../cli/server/webchat/sessionStore.js';
import { __testables as networkTestables } from '../../cli/server/webchat/network.js';

const FIRST_RUNTIME_INSTANCE_ID = '123e4567-e89b-42d3-a456-426614174000';
const SECOND_RUNTIME_INSTANCE_ID = '123e4567-e89b-42d3-a456-426614174001';

test('runtime-state envelopes update memory and SSE without entering conversation history', (t) => {
    const workspaceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-runtime-state-'));
    t.after(() => fs.rmSync(workspaceDirectory, { recursive: true, force: true }));
    const session = ensureCurrentSession(workspaceDirectory);
    const writes = [];
    const tab = {
        workspaceDirectory,
        sessionId: session.sessionId,
        subscribers: new Map([['client', { res: { write: (value) => writes.push(value) } }]]),
        workspaceHistory: {
            workspaceDirectory,
            sessionId: session.sessionId,
            buffer: '',
            lastClientText: '',
            userInputSent: false,
            lastAssistantMessageIndex: null,
        },
        taskProtocolBuffer: '',
    };
    const appState = { runtimes: new Map([['runtime', tab]]) };
    const envelope = JSON.stringify({
        __webchatRuntimeState: 1,
        version: 1,
        model: 'provider/deep-model',
    });

    routeWorkspaceRuntimeOutput(appState, tab, envelope.slice(0, 24));
    routeWorkspaceRuntimeOutput(appState, tab, `${envelope.slice(24)}\n`);

    assert.deepEqual(tab.webchatRuntimeState, { model: 'provider/deep-model' });
    assert.match(writes.join(''), /event: runtime-state/);
    assert.match(writes.join(''), /provider\/deep-model/);
    assert.deepEqual(loadSession(workspaceDirectory, session.sessionId).messages, []);
});

test('runtime-state model validation supports explicit clearing and rejects malformed values', () => {
    assert.deepEqual(parseWebchatRuntimeState({ __webchatRuntimeState: 1, version: 1, model: null }), { model: null });
    assert.deepEqual(parseWebchatRuntimeState({
        __webchatRuntimeState: 1,
        version: 1,
        model: 'deep',
        runtimeInstanceId: FIRST_RUNTIME_INSTANCE_ID,
    }), {
        model: 'deep',
        runtimeInstanceId: FIRST_RUNTIME_INSTANCE_ID,
    });
    assert.equal(parseWebchatRuntimeState({ __webchatRuntimeState: 1, version: 2, model: 'deep' }), undefined);
    assert.equal(parseWebchatRuntimeState({ __webchatRuntimeState: 1, version: 1, model: 42 }), undefined);
    assert.equal(parseWebchatRuntimeState({ __webchatRuntimeState: 1, version: 1, model: `bad\nmodel` }), undefined);
    assert.equal(parseWebchatRuntimeState({ __webchatRuntimeState: 1, version: 1, model: 'x'.repeat(257) }), undefined);
    assert.equal(parseWebchatRuntimeState({
        __webchatRuntimeState: 1,
        version: 1,
        model: 'deep',
        runtimeInstanceId: 'not-a-runtime-uuid',
    }), undefined);
});

test('runtime-state snapshots and browser payload parsing preserve selected model state', () => {
    assert.equal(
        serializeRuntimeStateSseEvent({ model: 'deep', runtimeInstanceId: FIRST_RUNTIME_INSTANCE_ID }),
        'event: runtime-state\ndata: {"model":"deep"}\n\n',
    );
    assert.deepEqual(networkTestables.parseRuntimeStatePayload('{"model":"deep"}'), { model: 'deep' });
    assert.deepEqual(networkTestables.parseRuntimeStatePayload('{"model":null}'), { model: null });
    assert.equal(networkTestables.parseRuntimeStatePayload('{"model":42}'), undefined);
});

test('a replacement runtime instance rearms disk-backed continuation exactly once', (t) => {
    const workspaceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-runtime-replacement-'));
    t.after(() => fs.rmSync(workspaceDirectory, { recursive: true, force: true }));
    const session = ensureCurrentSession(workspaceDirectory);
    appendSessionMessage(workspaceDirectory, session.sessionId, {
        role: 'user',
        text: 'Earlier question',
    });
    appendSessionMessage(workspaceDirectory, session.sessionId, {
        role: 'assistant',
        text: 'Earlier answer',
    });
    const ttyWrites = [];
    const tab = {
        tty: {
            write(value) {
                ttyWrites.push(value);
            },
        },
        workspaceDirectory,
        sessionId: session.sessionId,
        subscribers: new Map(),
        continuationHistory: [],
        continuationContext: '',
        continuationPending: false,
        pendingInteraction: { id: 'stale-interaction' },
        workspaceHistory: {
            workspaceDirectory,
            sessionId: session.sessionId,
            buffer: '',
            lastClientText: '',
            userInputSent: false,
            lastAssistantMessageIndex: null,
        },
        taskProtocolBuffer: '',
    };
    const effectiveConfig = { agentName: 'demo-agent', forwardEnvelope: true };
    const runtimeKey = buildRuntimeKey(workspaceDirectory, session.sessionId, effectiveConfig, '');
    const appState = { runtimes: new Map([[runtimeKey, tab]]) };

    routeWorkspaceRuntimeOutput(appState, tab, `${JSON.stringify({
        __webchatRuntimeState: 1,
        version: 1,
        model: 'fast',
        runtimeInstanceId: FIRST_RUNTIME_INSTANCE_ID,
    })}\n`);
    assert.equal(tab.continuationPending, false);

    routeWorkspaceRuntimeOutput(appState, tab, `${JSON.stringify({
        __webchatRuntimeState: 1,
        version: 1,
        model: 'deep',
        runtimeInstanceId: SECOND_RUNTIME_INSTANCE_ID,
    })}\n`);

    assert.deepEqual(tab.continuationHistory, [
        { role: 'user', message: 'Earlier question' },
        { role: 'assistant', message: 'Earlier answer' },
    ]);
    assert.match(tab.continuationContext, /Earlier question/);
    assert.equal(tab.continuationPending, true);
    assert.equal(tab.pendingInteraction, null);
    assert.deepEqual(tab.webchatRuntimeState, {
        model: 'deep',
        runtimeInstanceId: SECOND_RUNTIME_INSTANCE_ID,
    });

    const postInput = (text) => {
        const req = new EventEmitter();
        req.method = 'POST';
        req.headers = {};
        const statuses = [];
        const res = {
            writeHead(status) {
                statuses.push(status);
            },
            end() {},
        };
        handleRuntimeRoute({
            pathname: '/input',
            req,
            res,
            parsedUrl: new URL('http://localhost/input?tabId=tab-1'),
            appState,
            workspaceDirectory,
            effectiveConfig,
            agentQuery: '',
        });
        req.emit('data', JSON.stringify({ text, attachments: [] }));
        req.emit('end');
        assert.deepEqual(statuses, [204]);
    };

    postInput('Question after replacement');
    postInput('Next question on the same instance');

    const firstPayload = JSON.parse(ttyWrites[0]);
    const secondPayload = JSON.parse(ttyWrites[1]);
    assert.deepEqual(firstPayload.history, [
        { role: 'user', message: 'Earlier question' },
        { role: 'assistant', message: 'Earlier answer' },
    ]);
    assert.equal(secondPayload.history, undefined);
    assert.equal(tab.continuationPending, false);
});

test('same-instance runtime updates do not rearm continuation after a network reconnect', (t) => {
    const workspaceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-runtime-same-instance-'));
    t.after(() => fs.rmSync(workspaceDirectory, { recursive: true, force: true }));
    const session = ensureCurrentSession(workspaceDirectory);
    appendSessionMessage(workspaceDirectory, session.sessionId, {
        role: 'user',
        text: 'Persisted but already hydrated',
    });
    const tab = {
        workspaceDirectory,
        sessionId: session.sessionId,
        subscribers: new Map(),
        continuationHistory: [],
        continuationContext: '',
        continuationPending: false,
        webchatRuntimeState: {
            model: 'fast',
            runtimeInstanceId: FIRST_RUNTIME_INSTANCE_ID,
        },
        taskProtocolBuffer: '',
    };
    const appState = { runtimes: new Map([['runtime', tab]]) };

    routeWorkspaceRuntimeOutput(appState, tab, `${JSON.stringify({
        __webchatRuntimeState: 1,
        version: 1,
        model: 'deep',
        runtimeInstanceId: FIRST_RUNTIME_INSTANCE_ID,
    })}\n`);

    assert.deepEqual(tab.continuationHistory, []);
    assert.equal(tab.continuationContext, '');
    assert.equal(tab.continuationPending, false);
});

test('an EventSource reconnect receives the in-memory runtime-state snapshot', (t) => {
    const workspaceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-runtime-reconnect-'));
    t.after(() => fs.rmSync(workspaceDirectory, { recursive: true, force: true }));
    const session = ensureCurrentSession(workspaceDirectory);
    const effectiveConfig = { agentName: 'demo-agent' };
    const runtimeKey = buildRuntimeKey(workspaceDirectory, session.sessionId, effectiveConfig, '');
    const tab = {
        tty: {},
        subscribers: new Map(),
        sessionId: session.sessionId,
        workspaceDirectory,
        webchatRuntimeState: { model: 'deep' },
    };
    const sid = 'browser-session';
    const appState = {
        runtimes: new Map([[runtimeKey, tab]]),
        sessions: new Map([[sid, { tabs: new Map() }]]),
    };
    const req = new EventEmitter();
    req.headers = { cookie: `webchat_sid=${sid}` };
    const writes = [];
    const res = {
        writeHead(status) {
            assert.equal(status, 200);
        },
        write(value) {
            writes.push(value);
        },
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

    assert.match(writes.join(''), /event: runtime-state\ndata: {"model":"deep"}/);
    req.emit('close');
    if (tab.cleanupTimer) {
        clearTimeout(tab.cleanupTimer);
        tab.cleanupTimer = null;
    }
});

test('WebChat renders generic runtime model state beside the agent title', () => {
    const read = (relativePath) => fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    const template = read('../../cli/server/webchat/chat.html');
    const network = read('../../cli/server/webchat/network.js');
    const dom = read('../../cli/server/webchat/domSetup.js');
    const index = read('../../cli/server/webchat/index.js');
    const css = read('../../cli/server/webchat/webchat.css');

    assert.match(template, /id="titleBar"[\s\S]*id="runtimeModel" hidden/);
    assert.match(network, /addEventListener\('runtime-state'/);
    assert.match(dom, /function setRuntimeModel\(value\)/);
    assert.match(index, /onRuntimeState: \(state\) => dom\.setRuntimeModel\(state\?\.model\)/);
    assert.match(css, /\.wa-runtime-model/);
    assert.doesNotMatch(`${network}\n${dom}\n${index}`, /achilles-cli|\.achilles-cli|settings\.json/i);
});
