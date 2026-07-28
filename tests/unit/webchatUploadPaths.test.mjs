import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';

import {
    buildWorkspaceFileUrl,
    resolveUploadTarget,
    resolveWorkspaceDirectory,
    sanitizeUploadDirectoryPath,
    sanitizeUploadRelativePath,
} from '../../cli/server/webchat/uploadPaths.js';
import {
    handleWebchatUploadPost,
    resolveWebchatUploadContext,
} from '../../cli/server/handlers/webchat/uploads.js';
import {
    handleWorkspaceDirectoriesPost,
    listWorkspaceDirectory,
} from '../../cli/server/handlers/webchat/workspaceDirectories.js';

function makeTempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

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
        if (chunk) this.chunks.push(Buffer.from(String(chunk), encoding));
        return super.end(callback);
    }

    bodyJson() {
        return JSON.parse(Buffer.concat(this.chunks).toString('utf8'));
    }
}

function makeRequest({ method = 'POST', headers = {}, body = '' } = {}) {
    const req = Readable.from(body ? [Buffer.from(String(body))] : []);
    req.method = method;
    req.headers = headers;
    return req;
}

function waitForResponse(res) {
    if (res.writableFinished) return Promise.resolve();
    return new Promise((resolve) => res.once('finish', resolve));
}

async function upload(context, {
    destination = '',
    relativePath = 'note.txt',
    body = 'content',
    overwrite = false,
    mime = 'text/plain',
} = {}) {
    const req = makeRequest({
        headers: {
            'x-file-name': encodeURIComponent(path.basename(relativePath)),
            'x-relative-path': encodeURIComponent(relativePath),
            'x-destination-path': encodeURIComponent(destination),
            'x-mime-type': mime,
            ...(overwrite ? { 'x-overwrite': '1' } : {}),
        },
        body,
    });
    const res = new MockResponse();
    handleWebchatUploadPost(req, res, new URL('/webchat/uploads', 'http://localhost'), context);
    await waitForResponse(res);
    return res;
}

test('direct upload paths accept normal paths and reject reserved or escaping segments', () => {
    assert.equal(sanitizeUploadRelativePath('docs/report.pdf'), 'docs/report.pdf');
    assert.equal(sanitizeUploadDirectoryPath('src/assets'), 'src/assets');
    assert.equal(sanitizeUploadDirectoryPath(''), '');
    for (const unsafe of ['/absolute', '../escape', 'a/../b', '.ploinky/x', 'node_modules/x', '.secrets', 'a/key.secrets']) {
        assert.equal(sanitizeUploadRelativePath(unsafe), null, unsafe);
    }
});

test('resolveUploadTarget returns cwd-relative and workspace-relative direct paths', () => {
    const workspace = makeTempDir('webchat-direct-path');
    const cwd = path.join(workspace, 'project');
    fs.mkdirSync(cwd);
    try {
        const target = resolveUploadTarget({
            cwd,
            workspaceRoot: workspace,
            destinationPath: 'assets',
            relativePath: 'docs/readme.md',
        });
        assert.ok(target);
        assert.equal(target.relativePath, 'assets/docs/readme.md');
        assert.equal(target.workspacePath, 'project/assets/docs/readme.md');
        assert.equal(target.absolutePath, path.join(fs.realpathSync(cwd), 'assets', 'docs', 'readme.md'));
        assert.equal(buildWorkspaceFileUrl(target.workspacePath), '/workspace-files/project/assets/docs/readme.md');
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('direct upload rejects a working directory inside reserved runtime state', () => {
    const workspace = makeTempDir('webchat-reserved-base');
    const cwd = path.join(workspace, '.ploinky', 'runtime');
    fs.mkdirSync(cwd, { recursive: true });
    try {
        assert.equal(resolveUploadTarget({
            cwd,
            workspaceRoot: workspace,
            relativePath: 'note.txt',
        }), null);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('direct upload targets reject symlink components', (t) => {
    const workspace = makeTempDir('webchat-direct-symlink');
    const cwd = path.join(workspace, 'project');
    const outside = makeTempDir('webchat-direct-outside');
    fs.mkdirSync(cwd);
    try {
        try {
            fs.symlinkSync(outside, path.join(cwd, 'linked'), 'dir');
        } catch (error) {
            if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('symlinks unavailable');
            throw error;
        }
        assert.equal(resolveUploadTarget({
            cwd,
            workspaceRoot: workspace,
            destinationPath: 'linked',
            relativePath: 'escape.txt',
        }), null);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('directory explorer lists folders first and hides runtime, dependency, secret, and symlink entries', (t) => {
    const workspace = makeTempDir('webchat-directories');
    const cwd = path.join(workspace, 'project');
    fs.mkdirSync(cwd);
    fs.mkdirSync(path.join(cwd, 'docs'));
    fs.mkdirSync(path.join(cwd, '.git'));
    fs.mkdirSync(path.join(cwd, '.ploinky'));
    fs.mkdirSync(path.join(cwd, 'node_modules'));
    fs.writeFileSync(path.join(cwd, 'readme.md'), '# readme');
    fs.writeFileSync(path.join(cwd, '.secrets'), 'hidden');
    try {
        try {
            fs.symlinkSync(path.join(cwd, 'docs'), path.join(cwd, 'docs-link'), 'dir');
        } catch (error) {
            if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
            t.diagnostic('symlinks unavailable');
        }
        const listing = listWorkspaceDirectory({ cwd, workspaceRoot: workspace }, '');
        assert.deepEqual(listing.entries.map(({ name, kind }) => ({ name, kind })), [
            { name: '.git', kind: 'folder' },
            { name: 'docs', kind: 'folder' },
            { name: 'readme.md', kind: 'file' },
        ]);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('directory creation endpoint creates a confined folder', async () => {
    const workspace = makeTempDir('webchat-create-directory');
    const cwd = path.join(workspace, 'project');
    fs.mkdirSync(path.join(cwd, 'docs'), { recursive: true });
    const context = { cwd, workspaceRoot: workspace };
    try {
        const req = makeRequest({ headers: { 'content-type': 'application/json' }, body: '{"path":"docs/new"}' });
        const res = new MockResponse();
        await handleWorkspaceDirectoriesPost(req, res, context);
        await waitForResponse(res);
        assert.equal(res.statusCode, 201);
        assert.equal(res.bodyJson().path, 'docs/new');
        assert.equal(resolveWorkspaceDirectory({ cwd, workspaceRoot: workspace, relativePath: 'docs/new' })?.relativePath, 'docs/new');
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('directory creation rejects a missing parent instead of creating a hidden tree', async () => {
    const workspace = makeTempDir('webchat-missing-parent');
    const cwd = path.join(workspace, 'project');
    fs.mkdirSync(cwd);
    try {
        const req = makeRequest({ body: '{"path":"missing/new"}' });
        const res = new MockResponse();
        await handleWorkspaceDirectoriesPost(req, res, { cwd, workspaceRoot: workspace });
        await waitForResponse(res);
        assert.equal(res.statusCode, 400);
        assert.equal(res.bodyJson().error, 'invalid_parent');
        assert.equal(fs.existsSync(path.join(cwd, 'missing')), false);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('upload writes directly to the selected destination without session folders or metadata', async () => {
    const workspace = makeTempDir('webchat-direct-upload');
    const cwd = path.join(workspace, 'project');
    fs.mkdirSync(cwd);
    const context = resolveWebchatUploadContext({ workspaceBase: { root: workspace, base: cwd } });
    try {
        const res = await upload(context, {
            destination: 'incoming',
            relativePath: 'docs/note.md',
            body: '# hello',
            mime: 'text/markdown',
        });
        assert.equal(res.statusCode, 201);
        const payload = res.bodyJson();
        assert.equal(payload.localPath, 'incoming/docs/note.md');
        assert.equal(payload.workspacePath, 'project/incoming/docs/note.md');
        assert.equal(payload.downloadUrl, '/workspace-files/project/incoming/docs/note.md');
        assert.equal(payload.mime, 'text/markdown');
        assert.equal(fs.readFileSync(path.join(cwd, payload.localPath), 'utf8'), '# hello');
        assert.equal(fs.existsSync(path.join(cwd, 'uploads')), false);
        assert.equal(fs.readdirSync(path.dirname(path.join(cwd, payload.localPath))).some((name) => name.includes('.webchat-upload-')), false);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('upload refuses collisions until overwrite is explicitly confirmed', async () => {
    const workspace = makeTempDir('webchat-direct-overwrite');
    const cwd = path.join(workspace, 'project');
    fs.mkdirSync(path.join(cwd, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'docs', 'note.txt'), 'old');
    const context = resolveWebchatUploadContext({ workspaceBase: { root: workspace, base: cwd } });
    try {
        const blocked = await upload(context, { destination: 'docs', relativePath: 'note.txt', body: 'new' });
        assert.equal(blocked.statusCode, 409);
        assert.equal(blocked.bodyJson().error, 'target_exists');
        assert.equal(fs.readFileSync(path.join(cwd, 'docs', 'note.txt'), 'utf8'), 'old');

        const replaced = await upload(context, {
            destination: 'docs',
            relativePath: 'note.txt',
            body: 'new',
            overwrite: true,
        });
        assert.equal(replaced.statusCode, 201);
        assert.equal(fs.readFileSync(path.join(cwd, 'docs', 'note.txt'), 'utf8'), 'new');
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('confirmed folder upload merges files and preserves unrelated destination content', async () => {
    const workspace = makeTempDir('webchat-folder-merge');
    const cwd = path.join(workspace, 'project');
    fs.mkdirSync(path.join(cwd, 'target', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'target', 'docs', 'keep.txt'), 'keep');
    fs.writeFileSync(path.join(cwd, 'target', 'docs', 'replace.txt'), 'old');
    const context = resolveWebchatUploadContext({ workspaceBase: { root: workspace, base: cwd } });
    try {
        const replaced = await upload(context, {
            destination: 'target',
            relativePath: 'docs/replace.txt',
            body: 'new',
            overwrite: true,
        });
        const added = await upload(context, {
            destination: 'target',
            relativePath: 'docs/added.txt',
            body: 'added',
            overwrite: true,
        });
        assert.equal(replaced.statusCode, 201);
        assert.equal(added.statusCode, 201);
        assert.equal(fs.readFileSync(path.join(cwd, 'target', 'docs', 'replace.txt'), 'utf8'), 'new');
        assert.equal(fs.readFileSync(path.join(cwd, 'target', 'docs', 'added.txt'), 'utf8'), 'added');
        assert.equal(fs.readFileSync(path.join(cwd, 'target', 'docs', 'keep.txt'), 'utf8'), 'keep');
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('upload rejects file-versus-folder conflicts even with overwrite enabled', async () => {
    const workspace = makeTempDir('webchat-type-conflict');
    const cwd = path.join(workspace, 'project');
    fs.mkdirSync(path.join(cwd, 'existing'), { recursive: true });
    const context = resolveWebchatUploadContext({ workspaceBase: { root: workspace, base: cwd } });
    try {
        const response = await upload(context, { relativePath: 'existing', overwrite: true });
        assert.equal(response.statusCode, 409);
        assert.equal(response.bodyJson().error, 'target_type_conflict');
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});

test('aborted uploads leave neither a target nor a temporary sibling', async () => {
    const workspace = makeTempDir('webchat-aborted-upload');
    const cwd = path.join(workspace, 'project');
    fs.mkdirSync(cwd);
    const context = resolveWebchatUploadContext({ workspaceBase: { root: workspace, base: cwd } });
    try {
        const req = new PassThrough();
        req.method = 'POST';
        req.headers = {
            'x-file-name': 'partial.txt',
            'x-relative-path': 'partial.txt',
            'x-destination-path': '',
        };
        const res = new MockResponse();
        handleWebchatUploadPost(req, res, new URL('/webchat/uploads', 'http://localhost'), context);
        req.write('partial');
        req.emit('aborted');
        await new Promise((resolve) => setTimeout(resolve, 20));

        assert.equal(fs.existsSync(path.join(cwd, 'partial.txt')), false);
        assert.equal(fs.readdirSync(cwd).some((name) => name.includes('.webchat-upload-')), false);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});
