import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    appendSessionTurn,
    ensureCurrentSession,
    loadSession,
} from '../../cli/server/webchat/sessionStore.js';
import { handleRuntimeRoute } from '../../cli/server/handlers/webchat/runtimeRoutes.js';
import {
    buildRuntimeKey,
    routeWorkspaceRuntimeOutput,
} from '../../cli/server/handlers/webchat/runtimeState.js';

test('input persists the assistant placeholder before writing to the TTY', (t) => {
    const workspaceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-webchat-placeholder-'));
    t.after(() => fs.rmSync(workspaceDirectory, { recursive: true, force: true }));
    const session = ensureCurrentSession(workspaceDirectory);
    const effectiveConfig = { agentName: 'demo-agent' };
    const runtimeKey = buildRuntimeKey(workspaceDirectory, session.sessionId, effectiveConfig, '');
    let sessionAtWrite = null;
    let written = '';
    const tab = {
        tty: {
            write(value) {
                sessionAtWrite = loadSession(workspaceDirectory, session.sessionId);
                written = value;
            },
        },
        workspaceDirectory,
        sessionId: session.sessionId,
        subscribers: new Map(),
        workspaceHistory: {
            workspaceDirectory,
            sessionId: session.sessionId,
            buffer: '',
            lastClientText: '',
            userInputSent: false,
            lastAssistantMessageIndex: null,
        },
    };
    const appState = { runtimes: new Map([[runtimeKey, tab]]) };
    const req = new EventEmitter();
    req.method = 'POST';
    const response = { status: null };
    const res = {
        writeHead(status) {
            response.status = status;
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
    req.emit('data', JSON.stringify({ __webchatMessage: 1, text: 'Run analysis', attachments: [] }));
    req.emit('end');

    assert.equal(response.status, 204);
    assert.equal(written, 'Run analysis\n');
    assert.deepEqual(sessionAtWrite.messages.map(({ role }) => role), ['user', 'assistant']);
    assert.equal(sessionAtWrite.messages[1].text, '');
    assert.deepEqual(sessionAtWrite.messages[1].progress, []);
    assert.equal(tab.workspaceHistory.lastAssistantMessageIndex, 1);
});

test('runtime progress updates the active placeholder before final output', (t) => {
    const workspaceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-webchat-progress-'));
    t.after(() => fs.rmSync(workspaceDirectory, { recursive: true, force: true }));
    const session = ensureCurrentSession(workspaceDirectory);
    const turn = appendSessionTurn(workspaceDirectory, session.sessionId, { text: 'Run analysis' });
    const writes = [];
    const tab = {
        workspaceDirectory,
        sessionId: session.sessionId,
        subscribers: new Map([['client', { res: { write: (value) => writes.push(value) } }]]),
        workspaceHistory: {
            workspaceDirectory,
            sessionId: session.sessionId,
            buffer: '',
            lastClientText: 'Run analysis',
            userInputSent: false,
            lastAssistantMessageIndex: turn.assistantMessageIndex,
        },
        taskProtocolBuffer: '',
    };
    const appState = { runtimes: new Map([['runtime', tab]]) };

    routeWorkspaceRuntimeOutput(appState, tab, `${JSON.stringify({
        __webchatProgress: 1,
        reason: 'Reading source',
        tool: 'ignored-tool',
        stepIndex: 3,
    })}\n`);
    routeWorkspaceRuntimeOutput(appState, tab, 'Final answer\n');

    const loaded = loadSession(workspaceDirectory, session.sessionId);
    assert.deepEqual(loaded.messages[1].progress, ['Reading source']);
    assert.equal(loaded.messages[1].text, 'Final answer');
    assert.equal(JSON.stringify(loaded.messages[1]).includes('ignored-tool'), false);
    assert.match(writes.join(''), /__webchatProgress/);
    assert.match(writes.join(''), /Final answer/);
});
