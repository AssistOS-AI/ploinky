import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e3-download-')));
const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
fs.mkdirSync(path.join(workspace, '.ploinky'));
fs.writeFileSync(path.join(workspace, '.ploinky', 'agents.json'), JSON.stringify({
    fixture: { type: 'agent', agentName: 'fixture', repoName: 'repo', projectPath: workspace },
    empty: { type: 'agent', agentName: 'empty', repoName: 'repo', projectPath: workspace },
}));
const { handleBlobs } = await import('../../cli/server/handlers/blobs.js');
const { readAgentsSnapshot } = await import('../../cli/utils/workspace.js');
const agentDir = path.join(workspace, '.data', 'fixture', 'blobs');
const sharedDir = path.join(workspace, '.data', 'shared');
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(sharedDir, { recursive: true });
for (const directory of [agentDir, sharedDir]) {
    fs.writeFileSync(path.join(directory, 'sample'), '0123456789');
    fs.writeFileSync(path.join(directory, 'sample.json'), '{"mime":"text/plain"}');
    fs.writeFileSync(path.join(directory, 'large'), Buffer.alloc(256 * 1024, 120));
    fs.mkdirSync(path.join(directory, 'directory'));
}
test.after(() => {
    if (previousRoot === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
    else process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(workspace, { recursive: true, force: true });
});

class Response extends Writable {
    constructor({ disconnect = false } = {}) {
        super();
        this.headersSent = false;
        this.chunks = [];
        this.disconnect = disconnect;
        this.done = new Promise(resolve => this.once('close', resolve));
    }
    writeHead(status, headers = {}) {
        this.statusCode = status;
        this.headers = headers;
        this.headersSent = true;
    }
    _write(chunk, encoding, callback) {
        this.chunks.push(Buffer.from(chunk));
        if (this.disconnect) this.destroy();
        callback();
    }
}
function request(url, headers = {}, method = 'GET') {
    const req = new PassThrough();
    req.url = url;
    req.method = method;
    req.headers = headers;
    return req;
}
async function get(url, headers, method) {
    const res = new Response();
    await handleBlobs(request(url, headers, method), res);
    await res.done;
    return res;
}
function countSync(t) {
    const counts = {};
    for (const name of ['mkdirSync', 'readFileSync', 'existsSync', 'statSync', 'lstatSync',
        'realpathSync', 'openSync', 'fstatSync', 'readSync', 'closeSync']) {
        const original = fs[name];
        const wrapped = (...args) => {
            counts[name] = (counts[name] || 0) + 1;
            return original(...args);
        };
        const native = original.native;
        t.mock.method(fs, name, wrapped);
        if (native) t.mock.method(fs[name], 'native', (...args) => {
            counts[`${name}.native`] = (counts[`${name}.native`] || 0) + 1;
            return native(...args);
        });
    }
    return counts;
}

test('warm agent GET uses one registry stat and shared GET uses zero synchronous filesystem calls', async t => {
    readAgentsSnapshot();
    const counts = countSync(t);
    for (let i = 0; i < 200; i += 1) {
        const agent = await get('/blobs/fixture/sample');
        assert.equal(agent.statusCode, 200);
        assert.equal(Buffer.concat(agent.chunks).toString(), '0123456789');
        assert.deepEqual(counts, { statSync: i + 1 });
    }
    for (const key of Object.keys(counts)) delete counts[key];
    for (let i = 0; i < 200; i += 1) {
        const shared = await get('/blobs/sample');
        assert.equal(shared.statusCode, 200);
        assert.equal(Buffer.concat(shared.chunks).toString(), '0123456789');
    }
    assert.deepEqual(counts, {});
    t.diagnostic('200 warm agent GETs: 200 statSync; 200 shared GETs: zero sync filesystem calls');
});

test('blob ranges clamp oversized end, preserve bytes and headers, and reject start beyond EOF', async () => {
    for (const prefix of ['/blobs', '/blobs/fixture']) {
        const full = await get(`${prefix}/sample`);
        assert.equal(full.statusCode, 200);
        assert.equal(full.headers['Content-Length'], 10);
        assert.equal(full.headers['Content-Type'], 'text/plain');
        assert.equal(Buffer.concat(full.chunks).toString(), '0123456789');
        const range = await get(`${prefix}/sample`, { range: 'bytes=2-5' });
        assert.equal(range.statusCode, 206);
        assert.equal(range.headers['Content-Range'], 'bytes 2-5/10');
        assert.equal(range.headers['Content-Length'], 4);
        assert.equal(Buffer.concat(range.chunks).toString(), '2345');
        const clamped = await get(`${prefix}/sample`, { range: 'bytes=0-999999' });
        assert.equal(clamped.statusCode, 206);
        assert.equal(clamped.headers['Content-Range'], 'bytes 0-9/10');
        assert.equal(clamped.headers['Content-Length'], 10);
        assert.equal(Buffer.concat(clamped.chunks).toString(), '0123456789');
        const unsatisfiable = await get(`${prefix}/sample`, { range: 'bytes=10-99' });
        assert.equal(unsatisfiable.statusCode, 416);
        assert.equal(unsatisfiable.headers['Content-Range'], 'bytes */10');
        const reversed = await get(`${prefix}/sample`, { range: 'bytes=5-2' });
        assert.equal(reversed.statusCode, 200);
        assert.equal(Buffer.concat(reversed.chunks).toString(), '0123456789');
        const head = await get(`${prefix}/sample`, { range: 'bytes=2-5' }, 'HEAD');
        assert.equal(head.statusCode, 200);
        assert.equal(head.headers['Content-Length'], 10);
        assert.equal(Buffer.concat(head.chunks).length, 0);
    }
});

test('missing agent/id, rejected id and directory reads have no mkdir side effects', async t => {
    let mkdirs = 0;
    const original = fs.promises.mkdir;
    t.mock.method(fs.promises, 'mkdir', async (...args) => { mkdirs += 1; return original(...args); });
    for (const url of ['/blobs/empty/missing', '/blobs/fixture/missing',
        '/blobs/unknown/missing', '/blobs/directory', '/blobs/fixture/directory']) {
        assert.equal((await get(url)).statusCode, 404, url);
    }
    assert.equal((await get('/blobs/fixture/%2e%2e%2ffile')).statusCode, 400);
    assert.equal(mkdirs, 0);
    assert.equal(fs.existsSync(path.join(workspace, '.data', 'empty')), false);
});

test('200 early-disconnected and 200 midstream downloads close all owned handles and streams', async t => {
    // Linux is the qualified execution target; absence of /proc is a failed prerequisite.
    const fdCount = () => fs.readdirSync('/proc/self/fd').length;
    const initial = fdCount();
    const original = fs.promises.open;
    const handles = [];
    const streams = [];
    let earlyResponse;
    t.mock.method(fs.promises, 'open', async (...args) => {
        const handle = await original(...args);
        handles.push(handle);
        const create = handle.createReadStream.bind(handle);
        handle.createReadStream = options => {
            const stream = create(options);
            streams.push(stream);
            return stream;
        };
        earlyResponse?.destroy();
        return handle;
    });
    for (let i = 0; i < 200; i += 1) {
        earlyResponse = new Response();
        await handleBlobs(request('/blobs/large'), earlyResponse);
        await earlyResponse.done;
    }
    earlyResponse = null;
    assert.equal(streams.length, 0);
    assert.equal(handles.length, 200);
    assert.ok(handles.every(handle => handle.fd === -1));
    for (let i = 0; i < 200; i += 1) {
        const res = new Response({ disconnect: true });
        await handleBlobs(request('/blobs/large'), res);
        await res.done;
    }
    for (let i = 0; i < 100 && handles.some(handle => handle.fd !== -1); i += 1) await delay(2);
    assert.equal(streams.length, 200);
    assert.ok(streams.every(stream => stream.destroyed));
    assert.ok(handles.every(handle => handle.fd === -1));
    assert.equal(fdCount(), initial);
});

test('50 parallel blob reads and ten uploads preserve complete bytes and metadata', async () => {
    const reads = Array.from({ length: 50 }, (_, i) => get(i % 2 ? '/blobs/sample' : '/blobs/fixture/sample'));
    const writes = Array.from({ length: 10 }, async () => {
        const req = request('/blobs', { 'content-length': '1' }, 'POST');
        const res = new Response();
        const admission = handleBlobs(req, res);
        req.end('x');
        await admission;
        await res.done;
        assert.equal(res.statusCode, 201);
        const body = JSON.parse(Buffer.concat(res.chunks));
        assert.equal(fs.readFileSync(path.join(sharedDir, body.id), 'utf8'), 'x');
        assert.equal(JSON.parse(fs.readFileSync(path.join(sharedDir, `${body.id}.json`))).size, 1);
    });
    const responses = await Promise.all(reads);
    await Promise.all(writes);
    for (const response of responses) {
        assert.equal(response.statusCode, 200);
        assert.equal(Buffer.concat(response.chunks).toString(), '0123456789');
    }
    assert.equal(fs.readdirSync(sharedDir).some(name => name.endsWith('.part') || name.endsWith('.tmp')), false);
});

test('first POST creates missing shared and agent blob roots inside admission and persists data plus metadata', async () => {
    const missingShared = path.join(workspace, '.data', 'missingShared');
    for (const [url, directory, options] of [
        ['/blobs', missingShared, { sharedRecordResolver: () => ({ ok: true, agent: {
            blobsDir: missingShared, workspaceRoot: workspace, canonicalName: 'shared', isShared: true,
        } }) }],
        ['/blobs/empty', path.join(workspace, '.data', 'empty', 'blobs'), {}],
    ]) {
        assert.equal(fs.existsSync(directory), false);
        const req = request(url, { 'content-length': '1' }, 'POST');
        const res = new Response();
        const admitted = handleBlobs(req, res, options);
        req.end('x');
        await admitted;
        await res.done;
        assert.equal(res.statusCode, 201);
        const body = JSON.parse(Buffer.concat(res.chunks));
        assert.equal(fs.readFileSync(path.join(directory, body.id), 'utf8'), 'x');
        assert.equal(JSON.parse(fs.readFileSync(path.join(directory, `${body.id}.json`))).size, 1);
        assert.deepEqual(fs.readdirSync(directory).sort(), [body.id, `${body.id}.json`]);
    }
});
