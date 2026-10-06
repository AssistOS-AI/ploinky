import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { sendFile } from '../../cli/server/static/index.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-static-handles-'));
const bigFile = path.join(directory, 'big.bin');
fs.writeFileSync(bigFile, Buffer.alloc(8 * 1024 * 1024, 1));
const originalOpen = fs.promises.open;
const handles = [];

fs.promises.open = async (...args) => {
    const handle = await originalOpen(...args);
    const record = { closed: false };
    handle.on('close', () => { record.closed = true; });
    handles.push(record);
    return handle;
};

test.after(() => {
    fs.promises.open = originalOpen;
    fs.rmSync(directory, { recursive: true, force: true });
});

async function untilClosed(records) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && records.some((record) => !record.closed)) {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

function recordingResponse() {
    const res = new PassThrough();
    res.headWritten = false;
    res.writeHead = () => { res.headWritten = true; return res; };
    return res;
}

test('a response destroyed before the file is opened writes nothing and opens nothing', async () => {
    const before = handles.length;
    const res = recordingResponse();
    res.destroy();
    assert.equal(await sendFile(res, bigFile, { req: { headers: {} } }), true);
    assert.equal(res.headWritten, false);
    assert.equal(handles.length, before);
});

test('a client that goes away during the open/fstat awaits does not leak the handle', async () => {
    const res = recordingResponse();
    const patched = fs.promises.open;
    fs.promises.open = async (...args) => {
        const handle = await patched(...args);
        res.destroy(); // the reset lands while sendOpenedFile is awaiting
        return handle;
    };
    const start = handles.length;
    try {
        assert.equal(await sendFile(res, bigFile, { req: { headers: {} } }), true);
    } finally {
        fs.promises.open = patched;
    }
    const mine = handles.slice(start);
    assert.equal(mine.length, 1);
    await untilClosed(mine);
    assert.equal(res.headWritten, false, 'nothing is written to a destroyed response');
    assert.equal(mine[0].closed, true, 'the FileHandle is closed');
});

test('connections reset right after the request line leave no open FileHandle', async () => {
    const start = handles.length;
    const server = http.createServer(async (req, res) => { await sendFile(res, bigFile, { req }); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
        for (let i = 0; i < 60; i += 1) {
            const socket = net.connect(port, '127.0.0.1', () => {
                socket.write('GET /big.bin HTTP/1.1\r\nHost: a\r\n\r\n');
                setImmediate(() => (socket.resetAndDestroy ? socket.resetAndDestroy() : socket.destroy()));
            });
            socket.on('error', () => {});
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        const mine = handles.slice(start);
        await untilClosed(mine);
        assert.ok(mine.length > 0, 'some requests reached the open');
        assert.deepEqual(mine.filter((record) => !record.closed), [], 'every opened FileHandle is closed');
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
});
