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
    ensureCurrentSession,
    loadSession,
} from '../../cli/server/webchat/sessionStore.js';
import { __testables as networkTestables } from '../../cli/server/webchat/network.js';

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
    assert.equal(parseWebchatRuntimeState({ __webchatRuntimeState: 1, version: 2, model: 'deep' }), undefined);
    assert.equal(parseWebchatRuntimeState({ __webchatRuntimeState: 1, version: 1, model: 42 }), undefined);
    assert.equal(parseWebchatRuntimeState({ __webchatRuntimeState: 1, version: 1, model: `bad\nmodel` }), undefined);
    assert.equal(parseWebchatRuntimeState({ __webchatRuntimeState: 1, version: 1, model: 'x'.repeat(257) }), undefined);
});

test('runtime-state snapshots and browser payload parsing preserve selected model state', () => {
    assert.equal(
        serializeRuntimeStateSseEvent({ model: 'deep' }),
        'event: runtime-state\ndata: {"model":"deep"}\n\n',
    );
    assert.deepEqual(networkTestables.parseRuntimeStatePayload('{"model":"deep"}'), { model: 'deep' });
    assert.deepEqual(networkTestables.parseRuntimeStatePayload('{"model":null}'), { model: null });
    assert.equal(networkTestables.parseRuntimeStatePayload('{"model":42}'), undefined);
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
