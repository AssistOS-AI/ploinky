import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-assets-')));
const staticRoot = path.join(root, 'static');
fs.mkdirSync(path.join(root, '.ploinky'));
fs.mkdirSync(path.join(staticRoot, 'webchat'), { recursive: true });
fs.writeFileSync(path.join(root, '.ploinky', 'routing.json'), JSON.stringify({ static: { hostPath: staticRoot } }));
const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
process.env.PLOINKY_WORKSPACE_ROOT = root;
const { handleWebChat } = await import(`../../cli/server/handlers/webchat/index.js?asset-fall-through=${Date.now()}`);

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
    return req; // no req.user: the fall-through path redirects to the router login
}

function response() {
    const res = new PassThrough();
    res.statusCode = 0;
    res.headers = {};
    res.bodyText = '';
    res.writeHead = (statusCode, headers = {}) => { res.statusCode = statusCode; res.headers = headers; res.headersSent = true; };
    res.setEncoding('utf8');
    res.on('data', (chunk) => { res.bodyText += chunk; });
    res.finished = new Promise((resolve) => { res.on('end', resolve); });
    return res;
}

async function getAsset(name) {
    const res = response();
    const handled = handleWebChat(request(`/webchat/assets/${name}`), res, { agentName: 'generic-test-agent' },
        { sessions: new Map(), runtimes: new Map() });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('request hung: no response written')), 3000).unref());
    await Promise.race([Promise.all([handled, res.finished]), timeout]);
    return res;
}

test('a readable WebChat asset is served with validators', async () => {
    fs.writeFileSync(path.join(staticRoot, 'webchat', 'ok.txt'), 'asset body');
    const res = await getAsset('ok.txt');
    assert.equal(res.statusCode, 200);
    assert.equal(res.bodyText, 'asset body');
    assert.match(res.headers.ETag, /^W\//);
});

test('an asset that resolves but cannot be opened falls through instead of hanging', { skip: process.getuid?.() === 0 }, async () => {
    const file = path.join(staticRoot, 'webchat', 'locked.txt');
    fs.writeFileSync(file, 'secret');
    fs.chmodSync(file, 0o000);
    try {
        const res = await getAsset('locked.txt');
        assert.equal(res.statusCode, 302, 'falls through to the unauthenticated login redirect');
        assert.match(res.headers.Location, /^\/auth\/login\?/);
        assert.equal(res.bodyText.includes('secret'), false);
    } finally {
        fs.chmodSync(file, 0o600);
    }
});
