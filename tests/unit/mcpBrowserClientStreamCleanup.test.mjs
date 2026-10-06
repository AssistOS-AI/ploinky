import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(sourceRoot, 'cli/server/RoutingServer.js'), 'utf8');
const start = source.indexOf('function serveMcpBrowserClient(req, res) {');
const end = source.indexOf('\nfunction sendJsonResponse', start);
assert.ok(start >= 0 && end > start, 'extract the real synchronous route body');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e5-mcp-fd-'));
const file = path.join(root, 'MCPBrowserClient.js');
fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024, 65));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function loadHandler(fsApi = fs) {
    return vm.runInNewContext(`(${source.slice(start, end)})`, {
        fs: fsApi, MCP_BROWSER_CLIENT_PATH: file, appendLog() {},
    });
}
function response(write = (_chunk, _encoding, callback) => callback()) {
    const res = new Writable({ highWaterMark: 1, write });
    res.headers = {};
    res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; res.headersSent = true; };
    return res;
}

test('MCP browser client retains synchronous stat, HEAD bytes and headers', () => {
    let stats = 0;
    let streams = 0;
    const handler = loadHandler({
        statSync(...args) { stats += 1; return fs.statSync(...args); },
        createReadStream(...args) { streams += 1; return fs.createReadStream(...args); },
    });
    const res = response();
    assert.equal(handler({ method: 'HEAD' }, res), undefined, 'signature remains synchronous');
    assert.equal(stats, 1);
    assert.equal(streams, 0);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Length'], 2 * 1024 * 1024);
    assert.equal(res.headers['Content-Type'], 'application/javascript');
    assert.equal(res.headers['Cache-Control'], 'public, max-age=300');
});

test('aborted MCP-client GETs close every opened fd under backpressure', async () => {
    assert.equal(process.platform, 'linux', 'qualified Ubuntu operator is required for /proc/self/fd evidence');
    const countFds = () => fs.readdirSync('/proc/self/fd').length;
    const tracked = [];
    const handler = loadHandler({ ...fs, createReadStream(...args) {
        const stream = fs.createReadStream(...args); tracked.push(stream); return stream;
    } });
    const before = countFds();
    const responses = [];
    try {
        for (let index = 0; index < 32; index += 1) {
            let firstWrite;
            const written = new Promise(resolve => { firstWrite = resolve; });
            const res = response(() => { firstWrite(); });
            responses.push(res);
            handler({ method: 'GET' }, res);
            await written;
            res.destroy();
        }
        // Give fd close callbacks time to drain; removing cleanup keeps the
        // paused real file streams open and fails both assertions below.
        const deadline = Date.now() + 2000;
        while (tracked.some(stream => !stream.closed) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(countFds(), before, 'N aborted GETs leave the process fd count unchanged');
        assert.ok(tracked.every(stream => stream.closed), 'each request-owned stream is closed');
        assert.ok(responses.every(res => res.listenerCount('close') === 0), 'close hooks are removed');
    } finally {
        for (const stream of tracked) {
            if (!stream.closed) { const closed = once(stream, 'close'); stream.destroy(); await closed; }
        }
        for (const res of responses) res.destroy();
    }
});

test('MCP-client stream errors release stream ownership and do not write to destroyed responses', () => {
    let destroyed = 0;
    const stream = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    stream.pipe = () => {};
    stream.destroy = () => { destroyed += 1; };
    const handler = loadHandler({ statSync: () => ({ isFile: () => true, size: 1 }), createReadStream: () => stream });
    const res = response();
    handler({ method: 'GET' }, res);
    res.destroy();
    stream.emit('error', new Error('fixture stream failure'));
    assert.ok(destroyed >= 1);
    assert.equal(res.writableEnded, false, 'destroyed response receives no error body');
});
