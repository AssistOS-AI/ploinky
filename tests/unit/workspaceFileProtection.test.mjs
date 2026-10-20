import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

// config.js fixes the workspace root when it is first imported, so the
// fixture workspace is selected before the Router modules load.
const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-protected-files-')));
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
const { serveWorkspaceFileRequest } = await import('../../cli/server/static/index.js');

test.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

const SENTINEL = `protected-${process.pid}-${Date.now()}`;

function write(relativePath, content = SENTINEL) {
    const target = path.join(workspace, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

function link(relativePath, target) {
    const source = path.join(workspace, relativePath);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.symlinkSync(target, source);
}

write('.ploinky/routing.json', JSON.stringify({ routes: {}, marker: SENTINEL }));
write('.ploinky/agents.json');
write('.ploinky/data/master-key');
write('.ploinky/data/.secrets');
write('.ploinky/data/router-key');
write('.ploinky/repos/repo/agent/manifest.json', '{}');
write('.ploinky/repos/repo/agent/IDE-plugins/plugin/main.js', 'export const plugin = true;\n');
write('.ploinky/repos/repo/agent/IDE-plugins/plugin/deploy.secrets');
write('.ploinky/repos/repo/agent/master-key');
write('.ploinky/repos/repo/agent/.data/state.json');
write('.ploinky/repos/repo/README.md', '# Repository\n');
write('.data/userPersistoAgent/users.json');
write('.data/shared/blob.bin');
write('.data/site/index.html');
write('docs/readme.md', '# Ordinary\n');
write('docs/app.secrets');
write('docs/master-key');
write('projects/site/.data/cache.json');
write('projects/site/.ploinky/data/state.json');
write('.ploinky-notes/notes.txt', 'notes\n');
link('docs/key-link', '../.ploinky/data/router-key');
link('docs/state-link', '../.ploinky');
link('docs/data-link', '../.data/userPersistoAgent');
link('docs/site-link', '../.data/site');
link('docs/ghost-link', '../.data/userPersistoAgent/missing.json');
link('docs/repo-link', '../.ploinky/repos/repo');
link('.ploinky/repos/escape', '../data');

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

async function request(url, method = 'GET') {
    const req = { method, url, headers: { host: '127.0.0.1:8080' } };
    const res = streamingResponse();
    assert.equal(await serveWorkspaceFileRequest(req, res), true, url);
    await res.done;
    return res;
}

async function assertDenied(url, method = 'GET') {
    const res = await request(url, method);
    assert.equal(res.statusCode, 403, `${method} ${url}`);
    assert.equal(res.bodyText, 'Access denied', `${method} ${url}`);
    assert.ok(!res.bodyText.includes(SENTINEL), `${method} ${url} leaked protected bytes`);
}

async function assertServed(url, body) {
    const res = await request(url);
    assert.equal(res.statusCode, 200, url);
    assert.equal(res.bodyText, body, url);
}

// Every protected class is checked next to the two surfaces that must keep
// working: an ordinary workspace file and an agent asset under .ploinky/repos.
async function assertPositiveControls() {
    await assertServed('/workspace-files/docs/readme.md', '# Ordinary\n');
    await assertServed('/workspace-files/.ploinky/repos/repo/agent/IDE-plugins/plugin/main.js',
        'export const plugin = true;\n');
}

test('controller state under .ploinky is refused, including the master key and the secret store', async (t) => {
    await assertPositiveControls();
    for (const target of [
        '.ploinky/data/master-key',
        '.ploinky/data/.secrets',
        '.ploinky/data/router-key',
        '.ploinky/agents.json',
        '.ploinky/routing.json',
        '.ploinky/data/missing-file',
        '.ploinky/data',
        '.ploinky',
    ]) {
        await t.test(target, () => assertDenied(`/workspace-files/${target}`));
    }
    await t.test('HEAD .ploinky/data/master-key', () => assertDenied('/workspace-files/.ploinky/data/master-key', 'HEAD'));
});

test('agent private data under .data is refused, including blobs and directory indexes', async (t) => {
    await assertPositiveControls();
    for (const target of [
        '.data/userPersistoAgent/users.json',
        '.data/shared/blob.bin',
        '.data/site/',
        '.data/site/index.html',
        '.data/userPersistoAgent/missing.json',
        'projects/site/.data/cache.json',
    ]) {
        await t.test(target, () => assertDenied(`/workspace-files/${target}`));
    }
});

test('secret stores and master keys are refused anywhere in the workspace', async (t) => {
    await assertPositiveControls();
    for (const target of [
        'docs/app.secrets',
        'docs/master-key',
        'docs/missing.secrets',
        '.ploinky/repos/repo/agent/IDE-plugins/plugin/deploy.secrets',
        '.ploinky/repos/repo/agent/master-key',
        '.ploinky/repos/repo/agent/.data/state.json',
        'projects/site/.ploinky/data/state.json',
    ]) {
        await t.test(target, () => assertDenied(`/workspace-files/${target}`));
    }
});

test('repository checkouts and similarly named ordinary paths stay readable', async () => {
    await assertPositiveControls();
    await assertServed('/workspace-files/.ploinky/repos/repo/README.md', '# Repository\n');
    await assertServed('/workspace-files/docs/repo-link/README.md', '# Repository\n');
    await assertServed('/workspace-files/.ploinky-notes/notes.txt', 'notes\n');
    const missing = await request('/workspace-files/docs/missing.md');
    assert.equal(missing.statusCode, 404);
});

test('a symlink inside the workspace cannot reach a protected entry', async (t) => {
    await assertPositiveControls();
    for (const target of [
        'docs/key-link',
        'docs/state-link/agents.json',
        'docs/state-link/data/router-key',
        'docs/data-link/users.json',
        'docs/site-link/',
        '.ploinky/repos/escape/router-key',
        // A dangling link answers 403 whether or not its protected target
        // exists, so the status cannot reveal private file names.
        'docs/ghost-link',
        'docs/data-link/missing.json',
    ]) {
        await t.test(target, () => assertDenied(`/workspace-files/${target}`));
    }
});

test('encoded, doubled, dotted and trailing spellings of a protected path are refused', async (t) => {
    await assertPositiveControls();
    for (const url of [
        '/workspace-files/%2eploinky/data/master-key',
        '/workspace-files/%2Eploinky/data/master-key',
        '/workspace-files/.%70loinky/data/master-key',
        '/workspace-files/.ploinky%2Fdata%2Fmaster-key',
        '/workspace-files/.ploinky%2fdata%2f.secrets',
        '/workspace-files/.ploinky%5Cdata%5Crouter-key',
        '/workspace-files//.ploinky//data//master-key',
        '/workspace-files/./.ploinky/./data/./master-key',
        '/workspace-files/docs/%2e%2e/.ploinky/data/master-key',
        '/workspace-files/docs/%2e/../.data/userPersistoAgent/users.json',
        '/workspace-files/.ploinky/data/master-key/',
        '/workspace-files/.ploinky/data/master-key.',
        '/workspace-files/.ploinky/data/.',
        '/workspace-files/.data./userPersistoAgent/users.json',
        '/workspace-files/%2Edata/userPersistoAgent/users.json',
    ]) {
        await t.test(url, () => assertDenied(url));
    }
    // Double encoding names a literal `%2e…` entry, which does not exist.
    await t.test('/workspace-files/%252eploinky/data/master-key', async () => {
        const doubled = await request('/workspace-files/%252eploinky/data/master-key');
        assert.notEqual(doubled.statusCode, 200);
        assert.ok(!doubled.bodyText.includes(SENTINEL));
    });
});

test('case and Unicode variants that a folding filesystem resolves are refused', async (t) => {
    await assertPositiveControls();
    for (const url of [
        '/workspace-files/.PLOINKY/DATA/MASTER-KEY',
        '/workspace-files/.Ploinky/data/router-key',
        '/workspace-files/.ploinky/data/.SECRETS',
        '/workspace-files/.DATA/userPersistoAgent/users.json',
        '/workspace-files/docs/APP.Secrets',
        '/workspace-files/docs/Master-Key',
        // U+212A KELVIN SIGN and U+017F LATIN SMALL LETTER LONG S fold to k and s.
        '/workspace-files/.ploin%E2%84%AAy/data/router-key',
        '/workspace-files/.ploinky/data/ma%C5%BFter-key',
        '/workspace-files/.ploinky/data/.%C5%BFecrets',
    ]) {
        await t.test(url, () => assertDenied(url));
    }
});

test('a symlink swapped in between classification and open is refused', async (t) => {
    await assertPositiveControls();
    const target = path.join(workspace, 'docs', 'swap.txt');
    const protectedTarget = path.join(workspace, '.ploinky', 'data', 'router-key');
    const originalOpen = fs.promises.open;
    t.after(() => {
        fs.promises.open = originalOpen;
        fs.rmSync(target, { force: true });
    });
    for (const restoreAfterOpen of [false, true]) {
        fs.rmSync(target, { force: true });
        fs.writeFileSync(target, 'benign\n');
        fs.promises.open = async (filePath, ...rest) => {
            if (filePath !== target) return originalOpen(filePath, ...rest);
            fs.rmSync(target);
            fs.symlinkSync(protectedTarget, target);
            const handle = await originalOpen(filePath, ...rest);
            if (restoreAfterOpen) {
                fs.rmSync(target);
                fs.writeFileSync(target, 'benign\n');
            }
            return handle;
        };
        try {
            await assertDenied('/workspace-files/docs/swap.txt');
        } finally {
            fs.promises.open = originalOpen;
        }
    }
    fs.rmSync(target, { force: true });
    fs.writeFileSync(target, 'benign\n');
    await assertServed('/workspace-files/docs/swap.txt', 'benign\n');
});
