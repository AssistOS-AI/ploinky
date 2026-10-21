import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { streamZip } from '../../cli/server/static/zip-stream.mjs';
import { serveWorkspaceFileRequest } from '../../cli/server/static/index.js';
import { serveWorkspaceDownload, attachmentHeader } from '../../cli/server/static/workspace-downloads.mjs';
import { getWorkspaceRoot } from '../../cli/server/utils/workspacePaths.js';
import { routerSurfaceRequestClass } from '../../cli/server/authHandlers/authContext.js';

const execute = promisify(execFile);

// Independent central-directory decoder, including ZIP64 sizes and offsets.
function unzip(buffer) {
    const end = buffer.length - 98;
    assert.equal(buffer.readUInt32LE(end), 0x06064b50);
    const count = Number(buffer.readBigUInt64LE(end + 32));
    let offset = Number(buffer.readBigUInt64LE(end + 48));
    const entries = new Map();
    for (let index = 0; index < count; index += 1) {
        assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
        const extra = offset + 46 + nameLength;
        const rawSize = Number(buffer.readBigUInt64LE(extra + 4));
        const packedSize = Number(buffer.readBigUInt64LE(extra + 12));
        const local = Number(buffer.readBigUInt64LE(extra + 20));
        assert.equal(buffer.readUInt32LE(local), 0x04034b50);
        const dataOffset = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
        const packed = buffer.subarray(dataOffset, dataOffset + packedSize);
        const body = buffer.readUInt16LE(offset + 10) === 8 ? inflateRawSync(packed) : packed;
        assert.equal(body.length, rawSize);
        entries.set(name, body);
        offset += 46 + nameLength + extraLength + buffer.readUInt16LE(offset + 32);
    }
    return entries;
}

test('workspace download route: binary files, HEAD, ZIP, names, protection, and preview compatibility', async t => {
    const root = getWorkspaceRoot();
    const folder = await fs.mkdtemp(path.join(root, 'download-test-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'download-outside-'));
    const relative = path.relative(root, folder).split(path.sep).join('/');
    const server = http.createServer(async (req, res) => {
        if (!await serveWorkspaceFileRequest(req, res)) {
            res.writeHead(404);
            res.end();
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const request = (name = '', options = {}) => fetch(`${origin}/workspace-files/${relative}${name ? '/' + name.split('/').map(encodeURIComponent).join('/') : ''}?download=1`, options);
    try {
        const bytes = Buffer.from([0, 255, 128, 13, 10, 0, 42]);
        await fs.writeFile(path.join(folder, 'fișier #1 & %.bin'), bytes);
        await fs.mkdir(path.join(folder, 'nested', 'empty'), { recursive: true });
        await fs.writeFile(path.join(folder, 'nested', 'readme.md'), '# Example\n');
        await fs.writeFile(path.join(folder, 'nested', 'empty.bin'), '');
        await fs.mkdir(path.join(folder, 'nested', '.ploinky'));
        await fs.writeFile(path.join(folder, 'nested', '.ploinky', 'config.json'), 'private');
        await fs.mkdir(path.join(folder, 'nested', '.ploinky', 'repos', 'project'), { recursive: true });
        await fs.writeFile(path.join(folder, 'nested', '.ploinky', 'repos', 'project', 'source.js'), 'export const value = 1;');
        await fs.writeFile(path.join(folder, 'index.html'), '<h1>Preview</h1>');
        await fs.mkdir(path.join(folder, '.data'));
        await fs.writeFile(path.join(folder, '.data', 'private.txt'), 'private');
        await fs.writeFile(path.join(folder, 'credentials.secrets'), 'private');
        await fs.writeFile(path.join(outside, 'outside.txt'), 'outside');
        await fs.symlink(outside, path.join(folder, 'escape'));
        await fs.symlink(folder, path.join(folder, 'loop'));
        await fs.symlink(path.join(folder, '.data', 'private.txt'), path.join(folder, 'private-alias'));

        await t.test('file preserves bytes, filename and attachment headers', async () => {
            const response = await request('fișier #1 & %.bin');
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('content-type'), 'application/octet-stream');
            assert.equal(response.headers.get('cache-control'), 'no-store');
            assert.match(response.headers.get('content-disposition'), /attachment;.*filename\*=UTF-8''fi%C8%99ier%20%231%20%26%20%25.bin/);
            assert.equal(response.headers.get('content-length'), String(bytes.length));
            assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
        });
        await t.test('HEAD preflights file/folder without sending any content', async () => {
            for (const name of ['', 'fișier #1 & %.bin']) {
                const response = await request(name, { method: 'HEAD' });
                assert.equal(response.status, 200);
                assert.match(response.headers.get('content-disposition'), /^attachment;/);
                assert.equal((await response.arrayBuffer()).byteLength, 0);
            }
        });
        await t.test('folder is a recursive ZIP with empty directories, binary and UTF-8 names', async () => {
            const before = await fs.readdir(folder);
            const response = await request();
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('content-type'), 'application/zip');
            assert.match(response.headers.get('content-disposition'), /\.zip";/);
            const archive = Buffer.from(await response.arrayBuffer());
            const entries = unzip(archive);
            assert.deepEqual(entries.get(`${relative}/fișier #1 & %.bin`), bytes);
            assert.equal(entries.get(`${relative}/nested/readme.md`).toString(), '# Example\n');
            assert.ok(entries.has(`${relative}/nested/empty/`));
            assert.equal(entries.get(`${relative}/nested/empty.bin`).length, 0);
            assert.ok(![...entries.keys()].some(name => /private|escape|loop|\.data|\.ploinky|\.secrets/.test(name)));
            assert.deepEqual(await fs.readdir(folder), before);
            // Validate the real archive with an independent OS implementation.
            const zipFile = path.join(outside, 'test.zip');
            await fs.writeFile(zipFile, archive);
            const result = await execute('unzip', ['-t', zipFile]);
            assert.match(result.stdout, /No errors detected/);
        });
        await t.test('private paths, symlink escapes, traversal and missing entries are rejected', async () => {
            for (const name of ['.data/private.txt', 'credentials.secrets', 'private-alias', 'escape/outside.txt', 'nested/.ploinky/config.json']) {
                assert.equal((await request(name)).status, 403, name);
            }
            assert.equal((await request('missing')).status, 404);
            const traversal = await fetch(`${origin}/workspace-files/${relative}/%2e%2e%2f%2e%2e%2fetc/passwd?download=1`);
            assert.equal(traversal.status, 403);
            for (const name of ['.data/private', '.ploinky/config.json', '.ploinky']) {
                assert.equal((await fetch(`${origin}/workspace-files/${name}?download=1`)).status, 403, name);
            }
        });
        await t.test('existing preview still serves folder index inline; download rejects POST', async () => {
            const preview = await fetch(`${origin}/workspace-files/${relative}`);
            assert.equal(preview.status, 200);
            assert.equal(preview.headers.get('content-disposition'), 'inline');
            assert.equal(await preview.text(), '<h1>Preview</h1>');
            assert.equal((await request('index.html', { method: 'POST' })).status, 405);
            assert.equal(routerSurfaceRequestClass(`/workspace-files/${relative}`), 'router-sink');
        });
        await t.test('empty folder is a valid ZIP', async () => {
            const response = await request('nested/empty');
            assert.deepEqual([...unzip(Buffer.from(await response.arrayBuffer())).keys()], ['empty/']);
        });
        await t.test('managed repository source remains downloadable, unlike runtime metadata', async () => {
            const response = await request('nested/.ploinky/repos/project');
            assert.equal(response.status, 200);
            const entries = unzip(Buffer.from(await response.arrayBuffer()));
            assert.equal(entries.get('project/source.js').toString(), 'export const value = 1;');
        });
    } finally {
        await new Promise(resolve => server.close(resolve));
        await fs.rm(folder, { recursive: true, force: true });
        await fs.rm(outside, { recursive: true, force: true });
    }
});

test('download header cannot inject HTTP headers and carries a Unicode filename', () => {
    const header = attachmentHeader('răspuns "one"\r\n.txt');
    assert.ok(!header.includes('\r') && !header.includes('\n'));
    assert.match(header, /filename\*=UTF-8''r%C4%83spuns/);
    assert.match(header, /filename="r_spuns _one___.txt"/);
});

test('direct download refuses a response already disconnected, closing its opened file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'download-closed-'));
    const originalOpen = fs.open;
    let opened = 0;
    let closed = 0;
    try {
        await fs.writeFile(path.join(root, 'file'), 'data');
        fs.open = async (...args) => {
            const handle = await originalOpen(...args);
            opened += 1;
            const close = handle.close.bind(handle);
            handle.close = async () => { closed += 1; await close(); };
            return handle;
        };
        await serveWorkspaceDownload({ method: 'GET' }, { destroyed: true }, 'file', root);
        assert.equal(opened, 1);
        assert.equal(closed, 1);
    } finally {
        fs.open = originalOpen;
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('cancelling a large ZIP mid-stream closes the file and does not emit a completed archive', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'download-cancel-'));
    let closed = 0;
    try {
        const file = path.join(root, 'large.bin');
        await fs.writeFile(file, randomBytes(4 * 1024 * 1024));
        const stat = await fs.stat(file);
        const zip = streamZip([{
            name: 'folder/large.bin', stat, directory: false,
            async open() {
                const handle = await fs.open(file, 'r');
                const close = handle.close.bind(handle);
                handle.close = async () => { closed += 1; await close(); };
                return handle;
            }
        }]);
        assert.equal((await zip.next()).value.readUInt32LE(0), 0x04034b50);
        const compressed = await zip.next();
        assert.ok(compressed.value.length > 0 && compressed.value.length < stat.size);
        await zip.return();
        assert.equal(closed, 1);
        assert.equal((await zip.next()).done, true);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('file disappearing after enumeration fails the ZIP instead of returning a partial success', async () => {
    const zip = streamZip([{
        name: 'folder/missing.txt', stat: { mode: 0o100644, mtime: new Date() }, directory: false,
        async open() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }
    }]);
    await zip.next();
    await assert.rejects(zip.next(), { code: 'ENOENT' });
    assert.equal((await zip.next()).done, true);
});
