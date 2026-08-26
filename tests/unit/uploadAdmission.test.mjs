import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';

import {
    handleBlobs,
    handleWorkspaceUpload,
} from '../../cli/server/handlers/blobs.js';
import {
    handleWebchatUploadPost,
    resolveWebchatUploadContext,
} from '../../cli/server/handlers/webchat/uploads.js';
import { UPLOAD_ROUTE_POLICIES } from '../../cli/server/handlers/uploadAdmission.js';

class MockResponse extends Writable {
    constructor() {
        super();
        this.statusCode = 0;
        this.headers = {};
        this.headersSent = false;
        this.chunks = [];
    }

    writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        this.headers = headers;
        this.headersSent = true;
        return this;
    }

    _write(chunk, encoding, callback) {
        this.chunks.push(Buffer.from(chunk));
        callback();
    }

    end(chunk, encoding, callback) {
        if (chunk) {
            this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding));
        }
        return super.end(callback);
    }

    bodyText() {
        return Buffer.concat(this.chunks).toString('utf8');
    }
}

function temporaryDirectory(t, prefix) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function testPolicy(route, overrides = {}) {
    return {
        route,
        maxBytes: 8,
        maxFiles: 10,
        maxStorageBytes: 64,
        timeoutMs: 1_000,
        ...overrides,
    };
}

function endedRequest({ url, headers = {}, chunks = [] } = {}) {
    const request = Readable.from(chunks.map(chunk => (
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    )));
    request.method = 'POST';
    request.url = url;
    request.headers = headers;
    return request;
}

function openRequest({ url, headers = {} } = {}) {
    const request = new PassThrough();
    request.method = 'POST';
    request.url = url;
    request.headers = headers;
    return request;
}

function responseFinished(response) {
    if (response.writableFinished) return Promise.resolve();
    return new Promise(resolve => response.once('finish', resolve));
}

function regularFiles(root) {
    if (!fs.existsSync(root)) return [];
    const result = [];
    const stack = [root];
    while (stack.length > 0) {
        const directory = stack.pop();
        for (const name of fs.readdirSync(directory)) {
            const absolutePath = path.join(directory, name);
            const stat = fs.lstatSync(absolutePath);
            if (stat.isDirectory() && !stat.isSymbolicLink()) {
                stack.push(absolutePath);
            } else {
                result.push(path.relative(root, absolutePath));
            }
        }
    }
    return result.sort();
}

function webchatContext(root, sessionId = 'admissionSession') {
    return resolveWebchatUploadContext({
        workspaceBase: { root, base: root },
        sessionId,
    });
}

function sharedBlobResolver(blobsDir) {
    return () => ({
        ok: true,
        agent: {
            requestSegment: '',
            canonicalName: 'shared',
            repoName: null,
            projectPath: blobsDir,
            blobsDir,
            isShared: true,
        },
    });
}

function manualTimers() {
    const callbacks = new Map();
    let nextId = 1;
    return {
        api: {
            now: () => 0,
            setTimeout(callback, delay) {
                const id = nextId;
                nextId += 1;
                callbacks.set(id, { callback, delay });
                return id;
            },
            clearTimeout(id) {
                callbacks.delete(id);
            },
        },
        fireNext() {
            const entry = callbacks.entries().next().value;
            assert.ok(entry, 'an upload timeout must be scheduled');
            const [id, value] = entry;
            callbacks.delete(id);
            value.callback();
            return value.delay;
        },
    };
}

test('every upload route declares byte and timeout limits', () => {
    assert.deepEqual(
        Object.values(UPLOAD_ROUTE_POLICIES).map(policy => policy.route).sort(),
        ['/blobs', '/upload', '/webchat/uploads'],
    );
    for (const policy of Object.values(UPLOAD_ROUTE_POLICIES)) {
        for (const field of ['maxBytes', 'timeoutMs']) {
            assert.equal(Number.isSafeInteger(policy[field]), true, `${policy.route} ${field}`);
            assert.ok(policy[field] > 0, `${policy.route} ${field} must be positive`);
        }
    }
    assert.equal('maxFiles' in UPLOAD_ROUTE_POLICIES.workspace, false);
    assert.equal('maxStorageBytes' in UPLOAD_ROUTE_POLICIES.workspace, false);
    for (const policy of [UPLOAD_ROUTE_POLICIES.blobs, UPLOAD_ROUTE_POLICIES.webchat]) {
        for (const field of ['maxFiles', 'maxStorageBytes']) {
            assert.equal(Number.isSafeInteger(policy[field]), true, `${policy.route} ${field}`);
            assert.ok(policy[field] > 0, `${policy.route} ${field} must be positive`);
        }
    }
});

test('blob upload rejects an oversized Content-Length before creating data or metadata', async (t) => {
    const blobsDir = temporaryDirectory(t, 'blob-header-limit');
    const request = endedRequest({
        url: '/blobs',
        headers: { 'content-length': '9' },
        chunks: ['ignored'],
    });
    const response = new MockResponse();

    handleBlobs(request, response, {
        policy: testPolicy('/blobs'),
        sharedRecordResolver: sharedBlobResolver(blobsDir),
    });
    await responseFinished(response);

    assert.equal(response.statusCode, 413);
    assert.equal(response.bodyText(), 'upload_too_large');
    assert.deepEqual(regularFiles(blobsDir), []);
});

test('blob upload rejects a streamed byte overrun and deletes its partial target', async (t) => {
    const blobsDir = temporaryDirectory(t, 'blob-stream-limit');
    const request = endedRequest({
        url: '/blobs',
        chunks: ['1234', '5'],
    });
    const response = new MockResponse();

    handleBlobs(request, response, {
        policy: testPolicy('/blobs', { maxBytes: 4 }),
        sharedRecordResolver: sharedBlobResolver(blobsDir),
    });
    await responseFinished(response);

    assert.equal(response.statusCode, 413);
    assert.equal(response.bodyText(), 'upload_too_large');
    assert.deepEqual(regularFiles(blobsDir), []);
});

test('blob upload rejects Content-Length underflow and leaves no orphan metadata', async (t) => {
    const blobsDir = temporaryDirectory(t, 'blob-length-underflow');
    const request = endedRequest({
        url: '/blobs',
        headers: { 'content-length': '4' },
        chunks: ['12'],
    });
    const response = new MockResponse();

    handleBlobs(request, response, {
        policy: testPolicy('/blobs'),
        sharedRecordResolver: sharedBlobResolver(blobsDir),
    });
    await responseFinished(response);

    assert.equal(response.statusCode, 400);
    assert.equal(response.bodyText(), 'content_length_mismatch');
    assert.deepEqual(regularFiles(blobsDir), []);
});

test('successful blob upload still creates one data file and one metadata file', async (t) => {
    const blobsDir = temporaryDirectory(t, 'blob-success');
    const request = endedRequest({
        url: '/blobs',
        headers: {
            host: '127.0.0.1:8080',
            'content-length': '3',
            'x-file-name': 'note.txt',
            'x-mime-type': 'text/plain',
        },
        chunks: ['abc'],
    });
    const response = new MockResponse();

    handleBlobs(request, response, {
        policy: testPolicy('/blobs'),
        sharedRecordResolver: sharedBlobResolver(blobsDir),
    });
    await responseFinished(response);

    assert.equal(response.statusCode, 201);
    const payload = JSON.parse(response.bodyText());
    assert.equal(payload.size, 3);
    assert.equal(payload.filename, 'note.txt');
    assert.deepEqual(regularFiles(blobsDir), [payload.id, `${payload.id}.json`]);
    assert.equal(fs.readFileSync(path.join(blobsDir, payload.id), 'utf8'), 'abc');
});

test('webchat upload timeout uses the injected timer and removes its partial target', async (t) => {
    const root = temporaryDirectory(t, 'webchat-timeout');
    const context = webchatContext(root);
    const request = openRequest({
        url: '/webchat/uploads',
        headers: {
            'x-file-name': 'slow.txt',
            'x-relative-path': 'slow.txt',
        },
    });
    const response = new MockResponse();
    const timer = manualTimers();

    handleWebchatUploadPost(
        request,
        response,
        new URL('/webchat/uploads', 'http://127.0.0.1'),
        context,
        { policy: testPolicy('/webchat/uploads', { timeoutMs: 25 }), timers: timer.api },
    );
    request.write('partial');
    assert.equal(timer.fireNext(), 25);
    await responseFinished(response);
    request.destroy();

    assert.equal(response.statusCode, 408);
    assert.equal(JSON.parse(response.bodyText()).error, 'upload_timeout');
    assert.deepEqual(regularFiles(context.uploadRoot), []);
});

test('webchat upload count quota includes an in-flight reservation', async (t) => {
    const root = temporaryDirectory(t, 'webchat-count-reservation');
    const context = webchatContext(root);
    const policy = testPolicy('/webchat/uploads', { maxFiles: 1 });
    const firstRequest = openRequest({
        url: '/webchat/uploads',
        headers: {
            'content-length': '1',
            'x-file-name': 'first.txt',
        },
    });
    const firstResponse = new MockResponse();
    handleWebchatUploadPost(
        firstRequest,
        firstResponse,
        new URL('/webchat/uploads', 'http://127.0.0.1'),
        context,
        { policy },
    );
    firstRequest.write('a');

    const secondRequest = endedRequest({
        url: '/webchat/uploads',
        headers: {
            'content-length': '1',
            'x-file-name': 'second.txt',
        },
        chunks: ['b'],
    });
    const secondResponse = new MockResponse();
    handleWebchatUploadPost(
        secondRequest,
        secondResponse,
        new URL('/webchat/uploads', 'http://127.0.0.1'),
        context,
        { policy },
    );
    await responseFinished(secondResponse);

    assert.equal(secondResponse.statusCode, 507);
    assert.equal(JSON.parse(secondResponse.bodyText()).error, 'upload_count_quota_exceeded');

    firstRequest.end();
    await responseFinished(firstResponse);
    assert.equal(firstResponse.statusCode, 201);
    assert.deepEqual(regularFiles(context.uploadRoot), ['first.txt']);
});

test('webchat upload rejects stored-file count exhaustion', async (t) => {
    const root = temporaryDirectory(t, 'webchat-count-quota');
    const context = webchatContext(root);
    fs.mkdirSync(context.uploadRoot, { recursive: true });
    fs.writeFileSync(path.join(context.uploadRoot, 'existing.txt'), 'a');
    const request = endedRequest({
        url: '/webchat/uploads',
        headers: {
            'content-length': '1',
            'x-file-name': 'new.txt',
        },
        chunks: ['b'],
    });
    const response = new MockResponse();

    handleWebchatUploadPost(
        request,
        response,
        new URL('/webchat/uploads', 'http://127.0.0.1'),
        context,
        { policy: testPolicy('/webchat/uploads', { maxFiles: 1 }) },
    );
    await responseFinished(response);

    assert.equal(response.statusCode, 507);
    assert.equal(JSON.parse(response.bodyText()).error, 'upload_count_quota_exceeded');
    assert.deepEqual(regularFiles(context.uploadRoot), ['existing.txt']);
});

test('webchat upload quota ignores workspace paths that direct uploads cannot target', async (t) => {
    const root = temporaryDirectory(t, 'webchat-reserved-quota');
    const context = webchatContext(root);
    for (const reserved of ['.data', '.ploinky', 'node_modules']) {
        const directory = path.join(root, reserved);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'runtime-state.txt'), 'not upload storage');
    }
    fs.writeFileSync(path.join(root, '.secrets'), 'not upload storage');
    const request = endedRequest({
        url: '/webchat/uploads',
        headers: {
            'content-length': '1',
            'x-file-name': 'new.txt',
        },
        chunks: ['a'],
    });
    const response = new MockResponse();

    handleWebchatUploadPost(
        request,
        response,
        new URL('/webchat/uploads', 'http://127.0.0.1'),
        context,
        { policy: testPolicy('/webchat/uploads', { maxFiles: 1 }) },
    );
    await responseFinished(response);

    assert.equal(response.statusCode, 201);
    assert.equal(JSON.parse(response.bodyText()).relativePath, 'new.txt');
    assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'a');
});

test('webchat upload quota does not traverse reserved workspace directories', async (t) => {
    const root = temporaryDirectory(t, 'webchat-reserved-prune');
    const context = webchatContext(root);
    const reservedDirectory = path.join(root, '.ploinky');
    fs.mkdirSync(reservedDirectory, { recursive: true });
    fs.writeFileSync(path.join(reservedDirectory, 'runtime-state.txt'), 'not upload storage');
    const originalReaddirSync = fs.readdirSync;
    t.mock.method(fs, 'readdirSync', (directory, ...args) => {
        if (path.resolve(directory) === reservedDirectory) {
            throw new Error('reserved directory was traversed');
        }
        return originalReaddirSync(directory, ...args);
    });
    const request = endedRequest({
        url: '/webchat/uploads',
        headers: {
            'content-length': '1',
            'x-file-name': 'new.txt',
        },
        chunks: ['a'],
    });
    const response = new MockResponse();

    handleWebchatUploadPost(
        request,
        response,
        new URL('/webchat/uploads', 'http://127.0.0.1'),
        context,
        { policy: testPolicy('/webchat/uploads', { maxFiles: 1 }) },
    );
    await responseFinished(response);

    assert.equal(response.statusCode, 201);
    assert.equal(JSON.parse(response.bodyText()).relativePath, 'new.txt');
    assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'a');
});

test('webchat upload rejects stored-byte exhaustion without changing existing files', async (t) => {
    const root = temporaryDirectory(t, 'webchat-storage-quota');
    const context = webchatContext(root);
    fs.mkdirSync(context.uploadRoot, { recursive: true });
    fs.writeFileSync(path.join(context.uploadRoot, 'existing.txt'), '1234');
    const request = endedRequest({
        url: '/webchat/uploads',
        headers: {
            'content-length': '2',
            'x-file-name': 'new.txt',
        },
        chunks: ['56'],
    });
    const response = new MockResponse();

    handleWebchatUploadPost(
        request,
        response,
        new URL('/webchat/uploads', 'http://127.0.0.1'),
        context,
        { policy: testPolicy('/webchat/uploads', { maxStorageBytes: 5 }) },
    );
    await responseFinished(response);

    assert.equal(response.statusCode, 507);
    assert.equal(JSON.parse(response.bodyText()).error, 'upload_storage_quota_exceeded');
    assert.equal(fs.readFileSync(path.join(context.uploadRoot, 'existing.txt'), 'utf8'), '1234');
    assert.deepEqual(regularFiles(context.uploadRoot), ['existing.txt']);
});

test('workspace upload abort preserves the old target and deletes every partial file', async (t) => {
    const root = temporaryDirectory(t, 'workspace-abort');
    const targetPath = path.join(root, 'report.txt');
    fs.writeFileSync(targetPath, 'original');
    const request = openRequest({ url: '/upload?path=report.txt' });
    const response = new MockResponse();

    handleWorkspaceUpload(request, response, {
        workspaceRoot: root,
        policy: testPolicy('/upload', { maxBytes: 16, maxStorageBytes: 64 }),
    });
    request.write('replacement');
    request.emit('aborted');
    await responseFinished(response);
    request.destroy();

    assert.equal(response.statusCode, 400);
    assert.equal(JSON.parse(response.bodyText()).error, 'upload_aborted');
    assert.equal(fs.readFileSync(targetPath, 'utf8'), 'original');
    assert.deepEqual(regularFiles(root), ['report.txt']);
});

test('concurrent workspace replacements cannot credit old bytes before atomic commit', async (t) => {
    const root = temporaryDirectory(t, 'workspace-concurrent-quota');
    const firstPath = path.join(root, 'first.txt');
    const secondPath = path.join(root, 'second.txt');
    fs.writeFileSync(firstPath, '12345678');
    fs.writeFileSync(secondPath, 'abcdefgh');
    const policy = testPolicy('/upload', {
        maxBytes: 4,
        maxStorageBytes: 20,
    });
    const firstRequest = openRequest({
        url: '/upload?path=first.txt',
        headers: { 'content-length': '4' },
    });
    const firstResponse = new MockResponse();
    handleWorkspaceUpload(firstRequest, firstResponse, { workspaceRoot: root, policy });
    firstRequest.write('WXYZ');

    const secondRequest = endedRequest({
        url: '/upload?path=second.txt',
        headers: { 'content-length': '4' },
        chunks: ['IJKL'],
    });
    const secondResponse = new MockResponse();
    handleWorkspaceUpload(secondRequest, secondResponse, { workspaceRoot: root, policy });
    await responseFinished(secondResponse);

    assert.equal(secondResponse.statusCode, 507);
    assert.equal(JSON.parse(secondResponse.bodyText()).error, 'upload_storage_quota_exceeded');
    assert.equal(fs.readFileSync(secondPath, 'utf8'), 'abcdefgh');

    firstRequest.end();
    await responseFinished(firstResponse);
    assert.equal(firstResponse.statusCode, 200);
    assert.equal(fs.readFileSync(firstPath, 'utf8'), 'WXYZ');
    assert.deepEqual(regularFiles(root), ['first.txt', 'second.txt']);
});

test('successful workspace upload atomically replaces its target', async (t) => {
    const root = temporaryDirectory(t, 'workspace-success');
    const targetPath = path.join(root, 'report.txt');
    fs.writeFileSync(targetPath, 'old');
    fs.chmodSync(targetPath, 0o750);
    const request = endedRequest({
        url: '/upload?path=report.txt',
        headers: { 'content-length': '3' },
        chunks: ['new'],
    });
    const response = new MockResponse();

    handleWorkspaceUpload(request, response, {
        workspaceRoot: root,
        policy: testPolicy('/upload'),
    });
    await responseFinished(response);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.bodyText()), {
        ok: true,
        path: path.join(fs.realpathSync(root), 'report.txt'),
        size: 3,
    });
    assert.equal(fs.readFileSync(targetPath, 'utf8'), 'new');
    assert.equal(fs.statSync(targetPath).mode & 0o777, 0o750);
    assert.deepEqual(regularFiles(root), ['report.txt']);
});

test('workspace upload relies on filesystem capacity instead of cumulative inventory', async (t) => {
    const root = temporaryDirectory(t, 'workspace-filesystem-capacity');
    const runtimeDirectory = path.join(root, '.ploinky', 'runtime');
    fs.mkdirSync(runtimeDirectory, { recursive: true });
    for (let index = 0; index < 20; index += 1) {
        fs.writeFileSync(path.join(runtimeDirectory, `${index}.bin`), 'runtime');
    }
    const request = endedRequest({
        url: '/upload?path=.ploinky/user-file.bin',
        headers: { 'content-length': '2' },
        chunks: ['ok'],
    });
    const response = new MockResponse();

    handleWorkspaceUpload(request, response, {
        workspaceRoot: root,
    });
    await responseFinished(response);

    assert.equal(response.statusCode, 200);
    assert.equal(fs.readFileSync(path.join(root, '.ploinky', 'user-file.bin'), 'utf8'), 'ok');
});

test('workspace upload still enforces its per-file byte limit', async (t) => {
    const root = temporaryDirectory(t, 'workspace-byte-limit');
    const request = endedRequest({
        url: '/upload?path=large.bin',
        headers: {
            'content-length': String(UPLOAD_ROUTE_POLICIES.workspace.maxBytes + 1),
        },
        chunks: ['ignored'],
    });
    const response = new MockResponse();

    handleWorkspaceUpload(request, response, { workspaceRoot: root });
    await responseFinished(response);

    assert.equal(response.statusCode, 413);
    assert.equal(JSON.parse(response.bodyText()).error, 'upload_too_large');
    assert.equal(fs.existsSync(path.join(root, 'large.bin')), false);
});

test('workspace upload reports filesystem capacity exhaustion as 507', async (t) => {
    const root = temporaryDirectory(t, 'workspace-storage-full');
    const request = endedRequest({
        url: '/upload?path=file.bin',
        headers: { 'content-length': '1' },
        chunks: ['x'],
    });
    const response = new MockResponse();
    const originalOpenSync = fs.openSync;
    fs.openSync = (...args) => {
        if (String(args[0]).includes('.ploinky-upload-')) {
            const error = new Error('No space left on device');
            error.code = 'ENOSPC';
            throw error;
        }
        return originalOpenSync(...args);
    };

    try {
        handleWorkspaceUpload(request, response, { workspaceRoot: root });
        await responseFinished(response);
    } finally {
        fs.openSync = originalOpenSync;
    }

    assert.equal(response.statusCode, 507);
    assert.equal(JSON.parse(response.bodyText()).error, 'upload_storage_full');
    assert.equal(fs.existsSync(path.join(root, 'file.bin')), false);
});
