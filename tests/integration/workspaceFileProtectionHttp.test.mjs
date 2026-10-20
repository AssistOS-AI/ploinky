import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Offline: a real HTTP listener runs the Router's workspace-file dispatch
// (RoutingServer.js: isWorkspaceFileRequest, then serveWorkspaceFileRequest)
// against a fixture workspace. Raw request targets go over a socket, so Node's
// HTTP parser and URL handling see each spelling exactly as a client sent it.
// config.js fixes the workspace root when it is first imported.
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-protected-http-')));
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
const { isWorkspaceFileRequest, serveWorkspaceFileRequest } = await import('../../cli/server/static/index.js');

const SENTINEL = `protected-http-${process.pid}-${Date.now()}`;

function write(relativePath, content = SENTINEL) {
    const target = path.join(workspace, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

write('.ploinky/routing.json', JSON.stringify({ routes: {} }));
write('.ploinky/data/master-key');
write('.ploinky/data/.secrets');
write('.ploinky/data/router-key');
write('.ploinky/repos/repo/agent/manifest.json', '{}');
write('.ploinky/repos/repo/agent/IDE-plugins/plugin/main.js', 'export const plugin = true;\n');
write('.data/userPersistoAgent/users.json');
write('docs/readme.md', '# Ordinary\n');
write('docs/app.secrets');
write('.env', `PLOINKY_MASTER_KEY=${SENTINEL}\n`);
fs.symlinkSync('../.ploinky/data/router-key', path.join(workspace, 'docs', 'key-link'));

const server = http.createServer(async (req, res) => {
    if (isWorkspaceFileRequest(req) && await serveWorkspaceFileRequest(req, res)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('unrouted');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

test.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(workspace, { recursive: true, force: true });
});

function rawRequest(target, method = 'GET') {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1');
        const chunks = [];
        socket.on('data', chunk => chunks.push(chunk));
        socket.on('error', reject);
        socket.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1]);
            resolve({ status, body: text.slice(text.indexOf('\r\n\r\n') + 4), text });
        });
        socket.write(`${method} ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
}

async function assertDenied(target, method = 'GET') {
    const response = await rawRequest(target, method);
    assert.equal(response.status, 403, `${method} ${target}`);
    assert.ok(!response.text.includes(SENTINEL), `${method} ${target} leaked protected bytes`);
}

async function assertPositiveControls() {
    const ordinary = await rawRequest('/workspace-files/docs/readme.md');
    assert.equal(ordinary.status, 200);
    assert.equal(ordinary.body, '# Ordinary\n');
    const asset = await rawRequest('/workspace-files/.ploinky/repos/repo/agent/IDE-plugins/plugin/main.js');
    assert.equal(asset.status, 200);
    assert.equal(asset.body, 'export const plugin = true;\n');
}

test('raw HTTP requests for each protected class answer 403 and keep both positive controls', async (t) => {
    await assertPositiveControls();
    for (const target of [
        '/workspace-files/.ploinky/data/master-key',
        '/workspace-files/.ploinky/data/.secrets',
        '/workspace-files/.ploinky/data/router-key',
        '/workspace-files/.data/userPersistoAgent/users.json',
        '/workspace-files/docs/app.secrets',
        '/workspace-files/.env',
        '/workspace-files/docs/key-link',
    ]) {
        await t.test(target, () => assertDenied(target));
    }
    await t.test('HEAD /workspace-files/.ploinky/data/master-key',
        () => assertDenied('/workspace-files/.ploinky/data/master-key', 'HEAD'));
});

test('raw HTTP spellings of a protected path answer 403', async (t) => {
    await assertPositiveControls();
    for (const target of [
        '/workspace-files/%2eploinky/data/master-key',
        '/workspace-files/%2Eploinky/data/master-key',
        '/workspace-files/.ploinky%2Fdata%2Fmaster-key',
        '/workspace-files/.ploinky%5Cdata%5Crouter-key',
        '/workspace-files//.ploinky//data//master-key',
        '/workspace-files/./.ploinky/./data/master-key',
        '/workspace-files/docs/../.ploinky/data/master-key',
        '/workspace-files/docs/%2e%2e/.ploinky/data/master-key',
        '/workspace-files/docs/.%2E/.data/userPersistoAgent/users.json',
        '/workspace-files/.ploinky/data/master-key/',
        '/workspace-files/.ploinky/data/master-key.',
        '/workspace-files/.PLOINKY/DATA/MASTER-KEY',
        '/workspace-files/.ploin%E2%84%AAy/data/router-key',
        '/workspace-files/.ploinky/data/ma%C5%BFter-key',
        `http://127.0.0.1:${port}/workspace-files/.ploinky/data/master-key`,
    ]) {
        await t.test(target, () => assertDenied(target));
    }
    // Alternate mount spellings are not this route; they must not serve it.
    for (const target of [
        '/workspace-files%2F.ploinky/data/master-key',
        '/%77orkspace-files/.ploinky/data/master-key',
        '/workspace-files/%252eploinky/data/master-key',
    ]) {
        await t.test(target, async () => {
            const response = await rawRequest(target);
            assert.notEqual(response.status, 200, target);
            assert.ok(!response.text.includes(SENTINEL), target);
        });
    }
});
