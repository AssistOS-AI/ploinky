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

const { handleWebChat } = await import(`../../cli/server/handlers/webchat/index.js?session-api=${Date.now()}`);

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

test('WebChat page exposes the workspace-relative base used by file preview links', async () => {
    const appState = { sessions: new Map(), runtimes: new Map() };
    const response = await request(appState, '/webchat/?workspace-dir=project');

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /data-workspace-base="project"/);
});

test('conversation session REST routes are absent because the selected CLI owns sessions', async () => {
    const appState = { sessions: new Map(), runtimes: new Map() };
    const suffix = '?workspace-dir=project';
    for (const [route, options] of [
        [`/webchat/sessions${suffix}`, {}],
        [`/webchat/sessions${suffix}`, { method: 'POST' }],
        [`/webchat/sessions/current${suffix}`, { method: 'PUT' }],
        [`/webchat/sessions/123e4567-e89b-42d3-a456-426614174000${suffix}`, {}],
    ]) {
        const response = await request(appState, route, options);
        assert.equal(response.statusCode, 404);
    }
    assert.equal(fs.existsSync(path.join(project, '.copilot_history')), false);
    assert.equal(fs.existsSync(path.join(project, '.achilles-cli')), false);
});

test('retired session routes still pass through authentication before returning', async () => {
    fs.rmSync(path.join(project, '.copilot_history'), { recursive: true, force: true });
    const appState = { sessions: new Map(), runtimes: new Map() };
    const response = await request(appState, '/webchat/sessions?workspace-dir=project', { authenticated: false });
    assert.equal(response.statusCode, 302);
    assert.equal(fs.existsSync(path.join(project, '.copilot_history')), false);
});

test('workspace task API is authenticated and returns materialized metadata', async () => {
    const appState = { sessions: new Map(), runtimes: new Map() };
    const response = await request(appState, '/webchat/tasks?workspace-dir=project');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), { ok: true, tasks: [] });

    fs.rmSync(path.join(project, '.copilot_history'), { recursive: true, force: true });
    const denied = await request(appState, '/webchat/tasks?workspace-dir=project', { authenticated: false });
    assert.equal(denied.statusCode, 302);
    assert.equal(fs.existsSync(path.join(project, '.copilot_history')), false);
});

test('task view is authenticated and serves the side-panel page only for valid task ids', async () => {
    const appState = { sessions: new Map(), runtimes: new Map() };
    const taskId = 'task_1234567890abcdef12345678';
    const response = await request(appState, `/webchat/tasks/${taskId}/view?workspace-dir=project`);
    assert.equal(response.statusCode, 200);
    assert.match(response.getHeader('content-type'), /text\/html/);
    assert.equal(response.getHeader('cache-control'), 'no-cache, no-store, must-revalidate');
    assert.match(response.body, /class="wa-task-view-page"/);
    assert.match(response.body, /taskView\.js/);

    const invalid = await request(appState, '/webchat/tasks/not-a-task/view?workspace-dir=project');
    assert.equal(invalid.statusCode, 404);

    const denied = await request(appState, `/webchat/tasks/${taskId}/view?workspace-dir=project`, {
        authenticated: false,
    });
    assert.equal(denied.statusCode, 302);
});
