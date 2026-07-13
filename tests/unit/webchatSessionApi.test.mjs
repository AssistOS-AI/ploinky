import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-webchat-session-api-'));
const project = path.join(root, 'project');
fs.mkdirSync(project);
process.env.PLOINKY_WORKSPACE_ROOT = root;

const { handleWebChat } = await import(`../../cli/server/handlers/webchat.js?session-api=${Date.now()}`);

function makeRequest(url, { method = 'GET', body = '', authenticated = true, cookie = '' } = {}) {
    const req = Readable.from(body ? [Buffer.from(body)] : []);
    req.url = url;
    req.method = method;
    req.headers = { host: '127.0.0.1', cookie };
    req.socket = {};
    if (authenticated) req.user = { id: 'local:test', username: 'test', roles: ['user'] };
    return req;
}

function makeResponse() {
    const headers = new Map();
    let resolveEnd;
    const ended = new Promise((resolve) => { resolveEnd = resolve; });
    return {
        statusCode: 0,
        body: '',
        headers,
        ended,
        getHeader(name) { return headers.get(String(name).toLowerCase()); },
        setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
        writeHead(status, nextHeaders = {}) {
            this.statusCode = status;
            for (const [name, value] of Object.entries(nextHeaders)) this.setHeader(name, value);
        },
        write(chunk) { this.body += String(chunk || ''); return true; },
        end(chunk = '') { this.body += String(chunk || ''); resolveEnd(); },
    };
}

async function request(appState, url, options = {}) {
    const req = makeRequest(url, options);
    const res = makeResponse();
    await handleWebChat(req, res, { agentName: 'generic-test-agent' }, appState);
    await res.ended;
    return res;
}

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('folder-session API creates, lists, selects, and loads history without exposing messages in listings', async () => {
    const appState = { sessions: new Map(), runtimes: new Map() };
    const suffix = '?workspace-dir=project';
    const listed = await request(appState, `/webchat/sessions${suffix}`);
    assert.equal(listed.statusCode, 200);
    const initial = JSON.parse(listed.body);
    assert.equal(initial.sessions.length, 1);
    assert.equal(Object.hasOwn(initial.sessions[0], 'messages'), false);
    assert.equal(Object.hasOwn(initial.sessions[0], 'messageCount'), false);

    const createdResponse = await request(appState, `/webchat/sessions${suffix}`, { method: 'POST' });
    assert.equal(createdResponse.statusCode, 201);
    const created = JSON.parse(createdResponse.body).session;

    const selectedResponse = await request(appState, `/webchat/sessions/current${suffix}`, {
        method: 'PUT',
        body: JSON.stringify({ sessionId: initial.currentSessionId })
    });
    assert.equal(selectedResponse.statusCode, 200);
    assert.equal(JSON.parse(selectedResponse.body).session.sessionId, initial.currentSessionId);

    const loaded = await request(appState, `/webchat/sessions/${created.sessionId}${suffix}`);
    assert.equal(loaded.statusCode, 200);
    assert.deepEqual(JSON.parse(loaded.body).session.messages, []);
});

test('folder-session API redirects unauthenticated requests before touching project history', async () => {
    fs.rmSync(path.join(project, '.copilot_history'), { recursive: true, force: true });
    const appState = { sessions: new Map(), runtimes: new Map() };
    const response = await request(appState, '/webchat/sessions?workspace-dir=project', { authenticated: false });
    assert.equal(response.statusCode, 302);
    assert.equal(fs.existsSync(path.join(project, '.copilot_history')), false);
});
