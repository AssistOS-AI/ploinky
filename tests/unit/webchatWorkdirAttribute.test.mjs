import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

// The Box workspace is the selected host path, so any directory-name character
// can reach the rendered WebChat page and must stay inert attribute text.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'webchat "__WORKSPACE_BASE__ & root ')));
const directoryName = `quoted" data-injected="1 <b>&amp; ăîș __WORKSPACE_ROOT__`;
fs.mkdirSync(path.join(root, '.ploinky'));
fs.mkdirSync(path.join(root, directoryName));
const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
process.env.PLOINKY_WORKSPACE_ROOT = root;
const { handleWebChat } = await import(`../../cli/server/handlers/webchat/index.js?workdir-attribute=${Date.now()}`);

test.after(() => {
    if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(root, { recursive: true, force: true });
});

function request(url) {
    const req = Readable.from([]);
    req.url = url;
    req.method = 'GET';
    req.headers = { host: '127.0.0.1' };
    req.socket = {};
    req.user = { id: 'local:admin', username: 'admin', roles: ['user', 'admin'] };
    return req;
}

function response() {
    let resolveEnd;
    const ended = new Promise((resolve) => { resolveEnd = resolve; });
    return {
        statusCode: 0,
        body: '',
        ended,
        setHeader() {},
        getHeader() { return undefined; },
        writeHead(statusCode) { this.statusCode = statusCode; },
        write(chunk) { this.body += String(chunk || ''); return true; },
        end(chunk = '') { this.body += String(chunk || ''); resolveEnd(); },
    };
}

test('the WebChat page renders an arbitrary workspace directory as escaped attribute text', async () => {
    const res = response();
    await handleWebChat(
        request(`/webchat/?workspace-dir=${encodeURIComponent(directoryName)}`),
        res,
        { agentName: 'generic-test-agent' },
        { sessions: new Map(), runtimes: new Map() },
    );
    await res.ended;
    assert.equal(res.statusCode, 200, res.body.slice(0, 200));
    const expected = path.join(root, directoryName)
        .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
    assert.ok(res.body.includes(`data-workdir="${expected}"`), 'escaped workdir attribute');
    const expectedRoot = root.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    assert.ok(res.body.includes(`data-workspace-root="${expectedRoot}"`), 'root attribute preserves literal placeholder text');
    assert.ok(res.body.includes(`data-workspace-base="${encodeURIComponent(directoryName)}"`));
    assert.equal(res.body.includes('data-injected="1'), false);
    assert.equal(res.body.includes('<b>&amp;'), false);
});
