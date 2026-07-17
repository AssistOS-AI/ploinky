import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

import {
    buildSessionUploadMetadataRoot,
    buildSessionUploadRoot,
    buildSessionRelativePath,
    buildCwdRelativePath,
    ensureSessionUploadRoot,
    normalizeWebchatSessionId,
    resolveNonCollidingTarget,
    resolveUploadTarget,
    sanitizeUploadRelativePath,
} from '../../cli/server/webchat/uploadPaths.js';
import {
    listWorkspaceSuggestions,
} from '../../cli/server/handlers/webchat/workspaceSuggestions.js';
import {
    handleWebchatUploadGet,
    handleWebchatUploadPost,
    resolveWebchatUploadContext,
} from '../../cli/server/handlers/webchat/uploads.js';

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
        if (chunk) {
            this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding));
        }
        return super.end(callback);
    }

    bodyText() {
        return Buffer.concat(this.chunks).toString('utf8');
    }
}

function makeRequest({ method = 'GET', headers = {}, body = '' } = {}) {
    const chunks = body ? [Buffer.isBuffer(body) ? body : Buffer.from(String(body))] : [];
    const req = Readable.from(chunks);
    req.method = method;
    req.headers = headers;
    return req;
}

function waitForResponse(res) {
    return new Promise((resolve) => {
        res.on('finish', resolve);
    });
}

test('normalizeWebchatSessionId accepts hex-like ids and rejects unsafe values', () => {
    assert.equal(normalizeWebchatSessionId('a'.repeat(32)), 'a'.repeat(32));
    assert.equal(normalizeWebchatSessionId('sid-123_ABC'), 'sid-123_ABC');
    assert.equal(normalizeWebchatSessionId(''), null);
    assert.equal(normalizeWebchatSessionId('   '), null);
    assert.equal(normalizeWebchatSessionId('.'), null);
    assert.equal(normalizeWebchatSessionId('..'), null);
    assert.equal(normalizeWebchatSessionId('with/slash'), null);
    assert.equal(normalizeWebchatSessionId('with\\backslash'), null);
    assert.equal(normalizeWebchatSessionId('with space'), null);
    assert.equal(normalizeWebchatSessionId('with\0nul'), null);
});

test('sanitizeUploadRelativePath accepts plain and nested safe paths', () => {
    assert.equal(sanitizeUploadRelativePath('report.pdf', ''), 'report.pdf');
    assert.equal(sanitizeUploadRelativePath('folder/report.pdf', ''), 'folder/report.pdf');
    assert.equal(sanitizeUploadRelativePath('deep/nested/folder/file.txt', ''), 'deep/nested/folder/file.txt');
    assert.equal(sanitizeUploadRelativePath('', 'fallback.txt'), 'fallback.txt');
    assert.equal(sanitizeUploadRelativePath('folder\\sub\\file.txt', ''), 'folder/sub/file.txt');
    assert.equal(sanitizeUploadRelativePath('folder//double//slash.txt', ''), 'folder/double/slash.txt');
});

test('sanitizeUploadRelativePath rejects absolute paths, traversal, NUL, and secret files', () => {
    assert.equal(sanitizeUploadRelativePath('/absolute', 'fallback.txt'), null);
    assert.equal(sanitizeUploadRelativePath('../escape', 'fallback.txt'), null);
    assert.equal(sanitizeUploadRelativePath('folder/../../escape', 'fallback.txt'), null);
    assert.equal(sanitizeUploadRelativePath('inside/../escape', 'fallback.txt'), null);
    assert.equal(sanitizeUploadRelativePath('with\0nul', 'fallback.txt'), null);
    assert.equal(sanitizeUploadRelativePath('.secrets', 'fallback.txt'), null);
    assert.equal(sanitizeUploadRelativePath('folder/.secrets', 'fallback.txt'), null);
    assert.equal(sanitizeUploadRelativePath('config.secrets', 'fallback.txt'), null);
    assert.equal(sanitizeUploadRelativePath('a/config.secrets', 'fallback.txt'), null);
    assert.equal(sanitizeUploadRelativePath('', ''), null);
    assert.equal(sanitizeUploadRelativePath(null, null), null);
});

test('buildSessionUploadRoot composes cwd + uploads + sessionId', () => {
    const cwd = '/tmp/example';
    const sid = 'abc123';
    assert.equal(buildSessionUploadRoot(cwd, sid), path.join(path.resolve(cwd), 'uploads', sid));
    assert.equal(buildSessionUploadRoot(cwd, ''), null);
    assert.equal(buildSessionUploadRoot('', sid), null);
    assert.equal(buildSessionUploadRoot(cwd, 'bad/segment'), null);
});

test('buildSessionUploadMetadataRoot stores metadata outside the session file tree', () => {
    const cwd = '/tmp/example';
    const sid = 'abc123';
    assert.equal(
        buildSessionUploadMetadataRoot(cwd, sid),
        path.join(path.resolve(cwd), 'uploads', '.webchat-upload-metadata', sid)
    );
    assert.equal(buildSessionUploadMetadataRoot(cwd, 'bad/segment'), null);
});

test('resolveUploadTarget rejects paths that escape via .. and accepts safe ones', () => {
    const cwd = makeTempDir('webchat-upload-target');
    try {
        const sid = 'sessabc';
        const uploadRoot = buildSessionUploadRoot(cwd, sid);
        ensureSessionUploadRoot(uploadRoot);
        const canonicalRoot = fs.realpathSync(uploadRoot);
        const safe = resolveUploadTarget({ uploadRoot, workspaceRoot: cwd, relativePath: 'folder/notes.txt' });
        assert.ok(safe, 'safe relative path resolves');
        assert.equal(safe.relativePath, 'folder/notes.txt');
        assert.equal(path.relative(canonicalRoot, safe.absolutePath), path.join('folder', 'notes.txt'));

        const escape = resolveUploadTarget({ uploadRoot, workspaceRoot: cwd, relativePath: '../escape' });
        assert.equal(escape, null);
        const absoluteAttempt = resolveUploadTarget({ uploadRoot, workspaceRoot: cwd, relativePath: '/etc/passwd' });
        assert.equal(absoluteAttempt, null);
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});

test('resolveUploadTarget rejects symlink escapes outside the session upload root', () => {
    const cwd = makeTempDir('webchat-symlink-cwd');
    const outside = makeTempDir('webchat-symlink-outside');
    try {
        const sid = 'sessxyz';
        const uploadRoot = buildSessionUploadRoot(cwd, sid);
        ensureSessionUploadRoot(uploadRoot);
        fs.writeFileSync(path.join(outside, 'leak.txt'), 'never');
        try {
            fs.symlinkSync(path.join(outside, 'leak.txt'), path.join(uploadRoot, 'leak.txt'));
        } catch (err) {
            if (err.code === 'EPERM' || err.code === 'EACCES') return;
            throw err;
        }
        const resolved = resolveUploadTarget({
            uploadRoot,
            workspaceRoot: cwd,
            relativePath: 'leak.txt',
            allowMissingLeaf: false,
        });
        assert.equal(resolved, null);
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('ensureSessionUploadRoot rejects a symlinked uploads parent', () => {
    const cwd = makeTempDir('webchat-upload-parent-cwd');
    const outside = makeTempDir('webchat-upload-parent-outside');
    try {
        try {
            fs.symlinkSync(outside, path.join(cwd, 'uploads'), 'dir');
        } catch (err) {
            if (err.code === 'EPERM' || err.code === 'EACCES') return;
            throw err;
        }
        const uploadRoot = buildSessionUploadRoot(cwd, 'sessionA');
        assert.equal(ensureSessionUploadRoot(uploadRoot), false);
        assert.equal(fs.existsSync(path.join(outside, 'sessionA')), false);
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('resolveUploadTarget rejects an upload root that realpaths outside the workspace', () => {
    const cwd = makeTempDir('webchat-root-symlink-cwd');
    const outside = makeTempDir('webchat-root-symlink-outside');
    try {
        fs.mkdirSync(path.join(outside, 'sessionA'), { recursive: true });
        fs.writeFileSync(path.join(outside, 'sessionA', 'leak.txt'), 'outside');
        try {
            fs.symlinkSync(outside, path.join(cwd, 'uploads'), 'dir');
        } catch (err) {
            if (err.code === 'EPERM' || err.code === 'EACCES') return;
            throw err;
        }
        const uploadRoot = buildSessionUploadRoot(cwd, 'sessionA');
        const resolved = resolveUploadTarget({
            uploadRoot,
            workspaceRoot: cwd,
            relativePath: 'leak.txt',
            allowMissingLeaf: false,
        });
        assert.equal(resolved, null);
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('resolveNonCollidingTarget appends " (n)" suffix when leaf already exists', () => {
    const cwd = makeTempDir('webchat-collision');
    try {
        const sid = 'col1';
        const uploadRoot = buildSessionUploadRoot(cwd, sid);
        ensureSessionUploadRoot(uploadRoot);
        fs.writeFileSync(path.join(uploadRoot, 'report.pdf'), 'a');
        const first = resolveNonCollidingTarget({ uploadRoot, workspaceRoot: cwd, relativePath: 'report.pdf' });
        assert.ok(first);
        assert.equal(path.basename(first.absolutePath), 'report (1).pdf');
        fs.writeFileSync(first.absolutePath, 'b');
        const second = resolveNonCollidingTarget({ uploadRoot, workspaceRoot: cwd, relativePath: 'report.pdf' });
        assert.ok(second);
        assert.equal(path.basename(second.absolutePath), 'report (2).pdf');
        const nested = resolveNonCollidingTarget({ uploadRoot, workspaceRoot: cwd, relativePath: 'folder/sub.pdf' });
        assert.ok(nested);
        assert.equal(nested.relativePath, 'folder/sub.pdf');
        assert.equal(path.basename(nested.absolutePath), 'sub.pdf');
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});

test('buildSessionRelativePath and buildCwdRelativePath return forward-slash relative paths', () => {
    const cwd = makeTempDir('webchat-rel');
    try {
        const sid = 'sessrel';
        const uploadRoot = buildSessionUploadRoot(cwd, sid);
        ensureSessionUploadRoot(uploadRoot);
        const abs = path.join(uploadRoot, 'folder', 'notes.txt');
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, 'x');
        assert.equal(buildSessionRelativePath(uploadRoot, abs), 'folder/notes.txt');
        assert.equal(buildCwdRelativePath(cwd, abs), `uploads/${sid}/folder/notes.txt`);
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});

test('listWorkspaceSuggestions scoped to session upload root excludes sibling sessions and non-upload files', () => {
    const cwd = makeTempDir('webchat-session-scope');
    try {
        const sidA = 'sessionA';
        const sidB = 'sessionB';
        const rootA = buildSessionUploadRoot(cwd, sidA);
        const rootB = buildSessionUploadRoot(cwd, sidB);
        ensureSessionUploadRoot(rootA);
        ensureSessionUploadRoot(rootB);
        fs.writeFileSync(path.join(rootA, 'in-session.md'), 'a');
        fs.mkdirSync(path.join(rootA, 'folder'));
        fs.writeFileSync(path.join(rootA, 'folder', 'nested.txt'), 'a');
        fs.writeFileSync(path.join(rootB, 'sibling-secret.md'), 'b');
        fs.writeFileSync(path.join(cwd, 'workspace-only.md'), 'c');

        const result = listWorkspaceSuggestions({
            workspaceRoot: rootA,
            base: rootA,
            folder: '',
            leaf: '',
            limit: 20,
        });
        assert.equal(result.ok, true);
        const labels = result.items.map((entry) => entry.label).sort();
        assert.deepEqual(labels, ['folder', 'in-session.md']);
        assert.ok(!labels.includes('sibling-secret.md'));
        assert.ok(!labels.includes('workspace-only.md'));
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});

test('webchat upload GET preserves MIME metadata written at POST time', async () => {
    const cwd = makeTempDir('webchat-upload-mime');
    try {
        const sid = 'mimeSession';
        const context = resolveWebchatUploadContext({
            workspaceBase: { root: cwd, base: cwd },
            sessionId: sid,
        });
        const parsedPost = new URL('/webchat/uploads', 'http://127.0.0.1');
        const postReq = makeRequest({
            method: 'POST',
            headers: {
                'x-file-name': 'note.md',
                'x-relative-path': 'folder/note.md',
                'x-mime-type': 'text/markdown',
            },
            body: '# hello',
        });
        const postRes = new MockResponse();
        handleWebchatUploadPost(postReq, postRes, parsedPost, context);
        await waitForResponse(postRes);

        assert.equal(postRes.statusCode, 201);
        const payload = JSON.parse(postRes.bodyText());
        assert.equal(payload.mime, 'text/markdown');
        assert.equal(payload.relativePath, 'folder/note.md');
        assert.equal(payload.localPath, `uploads/${sid}/folder/note.md`);

        const parsedGet = new URL(`/webchat/uploads?path=${encodeURIComponent(payload.relativePath)}`, 'http://127.0.0.1');
        const getReq = makeRequest({ method: 'GET', headers: {} });
        const getRes = new MockResponse();
        handleWebchatUploadGet(getReq, getRes, parsedGet, context);
        await waitForResponse(getRes);

        assert.equal(getRes.statusCode, 200);
        assert.equal(getRes.headers['Content-Type'], 'text/markdown');
        assert.equal(getRes.bodyText(), '# hello');
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});

test('listWorkspaceSuggestions scoped to session upload root rejects symlink escapes to a sibling session', () => {
    const cwd = makeTempDir('webchat-session-symlink');
    try {
        const sidA = 'sessionA';
        const sidB = 'sessionB';
        const rootA = buildSessionUploadRoot(cwd, sidA);
        const rootB = buildSessionUploadRoot(cwd, sidB);
        ensureSessionUploadRoot(rootA);
        ensureSessionUploadRoot(rootB);
        fs.writeFileSync(path.join(rootB, 'private.txt'), 'shh');
        try {
            fs.symlinkSync(path.join(rootB, 'private.txt'), path.join(rootA, 'sibling-escape'));
        } catch (err) {
            if (err.code === 'EPERM' || err.code === 'EACCES') return;
            throw err;
        }
        const result = listWorkspaceSuggestions({
            workspaceRoot: rootA,
            base: rootA,
            folder: '',
            leaf: '',
            limit: 20,
        });
        const labels = result.items.map((entry) => entry.label);
        assert.ok(!labels.includes('sibling-escape'), 'must drop symlink escapes to other sessions');
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});
