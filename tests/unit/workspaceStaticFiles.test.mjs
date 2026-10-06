import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { serveWorkspaceFileRequest } from '../../cli/server/static/index.js';
import { getWorkspaceRoot } from '../../cli/server/utils/workspacePaths.js';

function createResponseRecorder() {
    return {
        statusCode: null,
        headers: null,
        body: '',
        writeHead(statusCode, headers = {}) {
            this.statusCode = statusCode;
            this.headers = headers;
            this.headersSent = true;
        },
        end(chunk = '') {
            this.body += String(chunk);
        }
    };
}

test('workspace file route returns 404 for missing in-workspace files', async () => {
    const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-workspace-files-'));
    try {
        process.env.PLOINKY_WORKSPACE_ROOT = workspaceRoot;
        fs.mkdirSync(path.join(workspaceRoot, '.ploinky', 'repos', 'repo', 'agent', 'IDE-plugins', 'plugin'), {
            recursive: true
        });

        const req = {
            method: 'GET',
            url: '/workspace-files/.ploinky/repos/repo/agent/IDE-plugins/plugin/missing.html',
            headers: { host: '127.0.0.1:8080' }
        };
        const res = createResponseRecorder();

        assert.equal(await serveWorkspaceFileRequest(req, res), true);
        assert.equal(res.statusCode, 404);
        assert.equal(res.body, 'Not Found');
    } finally {
        if (previousRoot === undefined) {
            delete process.env.PLOINKY_WORKSPACE_ROOT;
        } else {
            process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
        }
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('workspace file route streams Markdown inline with a previewable MIME type', async () => {
    const workspaceRoot = getWorkspaceRoot();
    const previewDirectory = fs.mkdtempSync(path.join(workspaceRoot, '.ploinky-workspace-preview-'));
    try {
        const filePath = path.join(previewDirectory, 'README.md');
        fs.writeFileSync(filePath, '# Preview\n');
        const relativePath = path.relative(workspaceRoot, filePath).replace(/\\+/g, '/');
        const req = {
            method: 'GET',
            url: `/workspace-files/${relativePath}`,
            headers: { host: '127.0.0.1:8080' },
        };
        const res = new PassThrough();
        res.statusCode = null;
        res.headers = null;
        res.writeHead = (statusCode, headers = {}) => {
            res.statusCode = statusCode;
            res.headers = headers;
        };
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        const finished = new Promise((resolve, reject) => {
            res.on('finish', resolve);
            res.on('error', reject);
        });

        assert.equal(await serveWorkspaceFileRequest(req, res), true);
        await finished;

        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['Content-Type'], 'text/markdown; charset=utf-8');
        assert.equal(res.headers['Content-Disposition'], 'inline');
        assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
        assert.equal(body, '# Preview\n');
    } finally {
        fs.rmSync(previewDirectory, { recursive: true, force: true });
    }
});

function streamingResponse() {
    const res = new PassThrough();
    res.statusCode = null;
    res.headers = null;
    res.writeHead = (statusCode, headers = {}) => {
        res.statusCode = statusCode;
        res.headers = headers;
        res.headersSent = true;
    };
    res.bodyText = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { res.bodyText += chunk; });
    res.done = new Promise((resolve, reject) => {
        res.on('end', resolve);
        res.on('error', reject);
    });
    return res;
}

async function getWorkspaceFile(relativePath, headers = {}) {
    const req = {
        method: 'GET',
        url: `/workspace-files/${relativePath}`,
        headers: { host: '127.0.0.1:8080', ...headers },
    };
    const res = streamingResponse();
    assert.equal(await serveWorkspaceFileRequest(req, res), true);
    await res.done;
    return res;
}

test('workspace files carry Content-Length and a weak ETag, stay private, and revalidate to 304', async () => {
    const workspaceRoot = getWorkspaceRoot();
    const directory = fs.mkdtempSync(path.join(workspaceRoot, '.ploinky-workspace-etag-'));
    try {
        fs.writeFileSync(path.join(directory, 'app.js'), 'export const value = 1;\n');
        fs.writeFileSync(path.join(directory, 'page.html'), '<h1>page</h1>');
        fs.writeFileSync(path.join(directory, 'empty.txt'), '');
        const base = path.relative(workspaceRoot, directory).replace(/\\+/g, '/');

        const first = await getWorkspaceFile(`${base}/app.js`);
        assert.equal(first.statusCode, 200);
        assert.equal(first.bodyText, 'export const value = 1;\n');
        assert.equal(first.headers['Content-Length'], Buffer.byteLength('export const value = 1;\n'));
        assert.match(first.headers.ETag, /^W\/"\d+-\d+-\d+"$/);
        assert.ok(first.headers['Last-Modified']);
        assert.equal(first.headers['Cache-Control'], 'private, max-age=300');

        const etag = first.headers.ETag;
        for (const header of [etag, etag.slice(2), `"other", ${etag}`, `W/"nope",${etag} , "x"`, '*']) {
            const revalidated = await getWorkspaceFile(`${base}/app.js`, { 'if-none-match': header });
            assert.equal(revalidated.statusCode, 304, header);
            assert.equal(revalidated.bodyText, '', header);
            assert.equal(revalidated.headers.ETag, etag);
            assert.equal(revalidated.headers['Cache-Control'], 'private, max-age=300');
        }
        for (const header of ['"other"', 'W/"1-2-3"', 'garbage', '']) {
            const miss = await getWorkspaceFile(`${base}/app.js`, { 'if-none-match': header });
            assert.equal(miss.statusCode, 200, header);
            assert.equal(miss.bodyText, 'export const value = 1;\n');
        }

        // The validator tracks the content: a rewritten file no longer matches.
        fs.writeFileSync(path.join(directory, 'app.js'), 'export const value = 22;\n');
        const changed = await getWorkspaceFile(`${base}/app.js`, { 'if-none-match': etag });
        assert.equal(changed.statusCode, 200);
        assert.equal(changed.bodyText, 'export const value = 22;\n');
        assert.notEqual(changed.headers.ETag, etag);

        const html = await getWorkspaceFile(`${base}/page.html`);
        assert.equal(html.headers['Cache-Control'], 'no-store');

        const empty = await getWorkspaceFile(`${base}/empty.txt`);
        assert.equal(empty.statusCode, 200);
        assert.equal(empty.headers['Content-Length'], 0);
        assert.equal(empty.bodyText, '');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
