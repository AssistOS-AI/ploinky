import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('WebChat exposes folder-session controls and lazy history loading', () => {
    const template = read('cli/server/webchat/chat.html');
    for (const id of ['newSessionBtn', 'loadSessionBtn', 'historyGate', 'loadHistoryBtn', 'sessionDialog', 'sessionList']) {
        assert.match(template, new RegExp(`id="${id}"`));
    }
});

test('WebChat tab identity is restored from sessionStorage before UUID fallback', () => {
    const dom = read('cli/server/webchat/domSetup.js');
    const readIndex = dom.indexOf('sessionStorage.getItem(tabStorageKey)');
    const uuidIndex = dom.indexOf('crypto.randomUUID()', readIndex);
    assert.ok(readIndex >= 0);
    assert.ok(uuidIndex > readIndex);
    assert.match(dom, /webchat_tab_id:/);
});

test('WebChat session API is authenticated before folder files are handled', () => {
    const handler = read('cli/server/handlers/webchat.js');
    const authGate = handler.indexOf('if (!authorized(req))');
    const sessionApi = handler.indexOf("pathname === '/sessions' && req.method === 'GET'");
    assert.ok(authGate >= 0);
    assert.ok(sessionApi > authGate);
    assert.match(handler, /buildRuntimeKey\(workspaceDirectory, currentSession\.sessionId/);
    assert.match(handler, /ttyFactory\.create\(ssoUser, \{[\s\S]*?sessionId: currentSession\.sessionId,[\s\S]*?hasHistory: currentSession\.messages\.length > 0/);
});
