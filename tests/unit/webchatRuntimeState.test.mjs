import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import {
    buildRuntimeKey,
    parseWebchatRuntimeState,
    parseWebchatSessionState,
    routeWorkspaceRuntimeOutput,
    serializeRuntimeStateSseEvent,
    serializeSessionStateSseEvent,
} from '../../cli/server/handlers/webchat/runtimeState.js';
import { handleRuntimeRoute } from '../../cli/server/handlers/webchat/runtimeRoutes.js';
import { __testables as networkTestables } from '../../cli/server/webchat/network.js';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';

function sessionEnvelope(event = 'current') {
    return {
        __webchatSession: 1,
        version: 1,
        event,
        session: {
            sessionId: SESSION_ID,
            createdAt: '2026-07-23T10:00:00.000Z',
            updatedAt: '2026-07-23T10:01:00.000Z',
            messages: [
                { role: 'user', text: 'Earlier question', timestamp: '2026-07-23T10:00:00.000Z', attachments: [], references: [] },
                { role: 'assistant', text: 'Earlier answer', timestamp: '2026-07-23T10:01:00.000Z', attachments: [], references: [] },
            ],
        },
        summary: {
            sessionId: SESSION_ID,
            preview: 'Earlier question',
            createdAt: '2026-07-23T10:00:00.000Z',
            updatedAt: '2026-07-23T10:01:00.000Z',
            hasHistory: true,
        },
    };
}

test('runtime state contains only the selected model', () => {
    assert.deepEqual(parseWebchatRuntimeState({ __webchatRuntimeState: 1, version: 1, model: 'deep' }), { model: 'deep' });
    assert.equal(parseWebchatRuntimeState({ __webchatRuntimeState: 1, version: 1, model: 42 }), undefined);
    assert.equal(serializeRuntimeStateSseEvent({ model: 'deep' }), 'event: runtime-state\ndata: {"model":"deep"}\n\n');
    assert.deepEqual(networkTestables.parseRuntimeStatePayload('{"model":"deep"}'), { model: 'deep' });
});

test('AchillesCLI session envelopes become in-memory SSE state without disk writes', (t) => {
    const workspaceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-session-state-'));
    t.after(() => fs.rmSync(workspaceDirectory, { recursive: true, force: true }));
    const writes = [];
    const tab = {
        workspaceDirectory,
        subscribers: new Map([['client', { res: { write: (value) => writes.push(value) } }]]),
        taskProtocolBuffer: '',
    };
    const appState = { runtimes: new Map([['runtime', tab]]) };
    const serialized = JSON.stringify(sessionEnvelope());

    routeWorkspaceRuntimeOutput(appState, tab, serialized.slice(0, 32));
    routeWorkspaceRuntimeOutput(appState, tab, `${serialized.slice(32)}\n`);

    assert.equal(tab.webchatSessionSnapshot.session.sessionId, SESSION_ID);
    assert.equal(tab.liveMessageCount, 2);
    assert.match(writes.join(''), /event: session-state/);
    assert.equal(fs.existsSync(path.join(workspaceDirectory, '.achilles-cli')), false);
    assert.equal(fs.existsSync(path.join(workspaceDirectory, '.copilot_history')), false);
});

test('session list envelopes are validated but do not replace the current snapshot', () => {
    const current = parseWebchatSessionState(sessionEnvelope());
    const list = parseWebchatSessionState({
        __webchatSession: 1,
        version: 1,
        event: 'list',
        currentSessionId: SESSION_ID,
        sessions: [sessionEnvelope().summary],
    });
    assert.equal(current.event, 'current');
    assert.deepEqual(list.sessions, [sessionEnvelope().summary]);
    assert.equal(parseWebchatSessionState({ ...sessionEnvelope(), version: 2 }), undefined);
    assert.match(serializeSessionStateSseEvent(current), /event: session-state/);
});

test('runtime identity is independent of the AchillesCLI conversation session', () => {
    const config = { agentName: 'achilles-cli' };
    const first = buildRuntimeKey('/workspace', config, 'agent=achilles-cli');
    const second = buildRuntimeKey('/workspace', config, 'agent=achilles-cli');
    assert.equal(first, second);
    assert.doesNotMatch(first, new RegExp(SESSION_ID));
});

test('an EventSource reconnect receives the in-memory session snapshot', (t) => {
    const workspaceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-session-reconnect-'));
    t.after(() => fs.rmSync(workspaceDirectory, { recursive: true, force: true }));
    const effectiveConfig = { agentName: 'demo-agent' };
    const runtimeKey = buildRuntimeKey(workspaceDirectory, effectiveConfig, '');
    const tab = {
        tty: {},
        subscribers: new Map(),
        workspaceDirectory,
        webchatSessionSnapshot: parseWebchatSessionState(sessionEnvelope()),
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
        writeHead(status) { assert.equal(status, 200); },
        write(value) { writes.push(value); },
        end() {},
    };

    handleRuntimeRoute({
        pathname: '/stream', req, res,
        parsedUrl: new URL('http://localhost/stream?tabId=tab-1'),
        appState, workspaceDirectory, effectiveConfig, agentQuery: '',
    });

    assert.match(writes.join(''), /event: session-state/);
    assert.match(writes.join(''), new RegExp(SESSION_ID));
    req.emit('close');
    if (tab.cleanupTimer) clearTimeout(tab.cleanupTimer);
});

test('a failed runtime write is rejected and the zombie runtime is removed', async () => {
    const workspaceDirectory = '/workspace';
    const effectiveConfig = { agentName: 'demo-agent', forwardEnvelope: true };
    const runtimeKey = buildRuntimeKey(workspaceDirectory, effectiveConfig, '');
    const sseWrites = [];
    let disposed = false;
    const tab = {
        tty: {
            isAlive: () => true,
            write: () => false,
            dispose: () => { disposed = true; },
        },
        pid: null,
        subscribers: new Map([['client', { res: { write: (value) => sseWrites.push(value), end() {} } }]]),
        workspaceDirectory,
        liveMessageCount: 0,
        backgroundTaskIds: new Set(),
        taskProtocolBuffer: '',
    };
    const appState = { runtimes: new Map([[runtimeKey, tab]]) };
    const req = new EventEmitter();
    req.method = 'POST';
    req.headers = {};
    let statusCode = null;
    let responseBody = '';
    let resolveEnded;
    const ended = new Promise((resolve) => { resolveEnded = resolve; });
    const res = {
        writeHead(status) { statusCode = status; },
        end(value = '') { responseBody += value; resolveEnded(); },
    };

    handleRuntimeRoute({
        pathname: '/input', req, res,
        parsedUrl: new URL('http://localhost/input?tabId=tab-1'),
        appState, workspaceDirectory, effectiveConfig, agentQuery: '',
    });
    req.emit('data', JSON.stringify({ __webchatMessage: 1, version: 1, text: 'hello' }));
    req.emit('end');
    await ended;

    assert.equal(statusCode, 409);
    assert.match(responseBody, /Reconnect/);
    assert.equal(disposed, true);
    assert.equal(appState.runtimes.has(runtimeKey), false);
    assert.doesNotMatch(sseWrites.join(''), /event: user-message/);
});

test('an EventSource reconnect replaces a runtime whose TTY is not alive', () => {
    const workspaceDirectory = '/workspace';
    const effectiveConfig = {
        agentName: 'demo-agent',
        ttyFactory: {
            create() {
                return {
                    pid: 202,
                    isAlive: () => true,
                    onOutput() {},
                    onClose() {},
                    dispose() {},
                    write: () => true,
                };
            },
        },
    };
    const runtimeKey = buildRuntimeKey(workspaceDirectory, effectiveConfig, '');
    let disposed = false;
    const staleTab = {
        tty: {
            isAlive: () => false,
            dispose: () => { disposed = true; },
        },
        subscribers: new Map(),
        workspaceDirectory,
        backgroundTaskIds: new Set(),
        taskProtocolBuffer: '',
    };
    const sid = 'browser-session';
    const appState = {
        runtimes: new Map([[runtimeKey, staleTab]]),
        sessions: new Map([[sid, { tabs: new Map() }]]),
    };
    const req = new EventEmitter();
    req.headers = { cookie: `webchat_sid=${sid}` };
    const res = {
        writeHead(status) { assert.equal(status, 200); },
        write() {},
        end() {},
    };

    handleRuntimeRoute({
        pathname: '/stream', req, res,
        parsedUrl: new URL('http://localhost/stream?tabId=tab-1'),
        appState, workspaceDirectory, effectiveConfig, agentQuery: '',
    });

    assert.equal(disposed, true);
    assert.notEqual(appState.runtimes.get(runtimeKey), staleTab);
    req.emit('close');
    const replacement = appState.runtimes.get(runtimeKey);
    if (replacement?.cleanupTimer) clearTimeout(replacement.cleanupTimer);
});

test('WebChat renders generic runtime model state beside the agent title', () => {
    const read = (relativePath) => fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    const template = read('../../cli/server/webchat/chat.html');
    const network = read('../../cli/server/webchat/network.js');
    const dom = read('../../cli/server/webchat/domSetup.js');
    const index = read('../../cli/server/webchat/index.js');
    assert.match(template, /id="titleBar"[\s\S]*id="runtimeModel" hidden/);
    assert.match(network, /addEventListener\('runtime-state'/);
    assert.match(index, /onRuntimeState: \(state\) => dom\.setRuntimeModel\(state\?\.model\)/);
    assert.doesNotMatch(`${network}\n${dom}\n${index}`, /runtimeInstanceId/);
});
