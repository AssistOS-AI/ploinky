import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';

import * as suggestions from '../../cli/server/handlers/webchat/workspaceSuggestions.js';
import { listWorkspaceDirectory, handleWorkspaceDirectoriesGet,
    handleWorkspaceDirectoriesPost } from '../../cli/server/handlers/webchat/workspaceDirectories.js';
import { resolveWorkspaceDirectory,
    sanitizeUploadDirectoryPath } from '../../cli/server/webchat/uploadPaths.js';
import * as paths from '../../cli/server/utils/workspacePaths.js';

const suggestAsync = suggestions.listWorkspaceSuggestionsAsync || suggestions.listWorkspaceSuggestions;
const baseAsync = suggestions.resolveWebchatWorkspaceBaseAsync || suggestions.resolveWebchatWorkspaceBase;
const pathAsync = paths.resolveWorkspacePathAsync || paths.resolveWorkspacePath;

function fixture(t, prefix) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `workspace-browse-${prefix}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function response() {
    return {
        status: 0,
        body: '',
        writeHead(status) { this.status = status; },
        end(body) { this.body = JSON.parse(body); }
    };
}

// The pre-E4 directory algorithm: keep the synchronous lstat and comparator
// as an independent oracle, including special-file and sanitization filters.
function directoryOracle(context, relativePath = '') {
    const directory = resolveWorkspaceDirectory({ ...context, relativePath });
    if (!directory) return null;
    const entries = [];
    for (const entry of fs.readdirSync(directory.absolutePath, { withFileTypes: true })) {
        const itemPath = directory.relativePath ? `${directory.relativePath}/${entry.name}` : entry.name;
        const safePath = sanitizeUploadDirectoryPath(itemPath);
        if (safePath === null) continue;
        let stat;
        try { stat = fs.lstatSync(path.join(directory.absolutePath, entry.name)); } catch (_) { continue; }
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) continue;
        entries.push({ name: entry.name, path: safePath, kind: stat.isDirectory() ? 'folder' : 'file' });
    }
    entries.sort((left, right) => left.kind !== right.kind
        ? (left.kind === 'folder' ? -1 : 1)
        : left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
    const parent = path.posix.dirname(directory.relativePath);
    return { path: directory.relativePath,
        parentPath: directory.relativePath ? (parent === '.' ? '' : parent) : null, entries };
}

function hashOrder(entries) {
    const keyed = entries.map((entry) => ({ entry,
        key: createHash('sha256').update(entry.name).digest('hex') }));
    keyed.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    return keyed.map(({ entry }) => entry);
}

function shuffleReaddir(t) {
    const syncRead = fs.readdirSync;
    const asyncRead = fs.promises.readdir;
    t.mock.method(fs, 'readdirSync', (...args) => hashOrder(syncRead(...args)));
    t.mock.method(fs.promises, 'readdir', async (...args) => hashOrder(await asyncRead(...args)));
}

function countLeafStats(t, root) {
    const count = { sync: 0, async: 0, inFlight: 0, maxInFlight: 0 };
    const syncStat = fs.lstatSync;
    const asyncStat = fs.promises.lstat;
    t.mock.method(fs, 'lstatSync', (target, ...args) => {
        if (path.dirname(String(target)) === root) count.sync += 1;
        return syncStat(target, ...args);
    });
    t.mock.method(fs.promises, 'lstat', async (target, ...args) => {
        if (path.dirname(String(target)) !== root) return asyncStat(target, ...args);
        count.async += 1;
        count.inFlight += 1;
        count.maxInFlight = Math.max(count.maxInFlight, count.inFlight);
        try { return await asyncStat(target, ...args); } finally { count.inFlight -= 1; }
    });
    return count;
}

function forbidSyncPathReads(t) {
    for (const method of ['realpathSync', 'lstatSync', 'readdirSync']) {
        t.mock.method(fs, method, () => { throw new Error(`unexpected ${method}`); });
    }
}

test('async directory listing matches the 5000-entry shuffled oracle without per-entry lstat', async (t) => {
    const root = fixture(t, 'directories-large');
    for (let index = 0; index < 5000; index += 1) {
        const target = path.join(root, `entry-${String(index).padStart(4, '0')}`);
        if (index % 20 === 0) fs.mkdirSync(target);
        else fs.writeFileSync(target, 'x');
    }
    shuffleReaddir(t);
    const context = { cwd: root, workspaceRoot: root };
    const expected = directoryOracle(context);
    const count = countLeafStats(t, root);
    assert.deepEqual(await listWorkspaceDirectory(context), expected);
    assert.equal(count.sync + count.async, 0, 'directory kinds must come from Dirents');
    const res = response();
    await handleWorkspaceDirectoriesGet({}, res, new URL('http://localhost/webchat/directories'), context);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, ...expected });
});

test('async directory listing filters symlinks, FIFOs and reserved names and uses async mkdir', async (t) => {
    const root = fixture(t, 'directories-special');
    fs.mkdirSync(path.join(root, 'docs'));
    for (const name of ['Alpha', 'alpha', 'á', 'a', 'Ω', '.gitignore', '.secrets', 'key.secrets']) {
        fs.writeFileSync(path.join(root, name), 'x');
    }
    fs.symlinkSync(path.join(root, 'docs'), path.join(root, 'link'));
    execFileSync('mkfifo', [path.join(root, 'fifo')]);
    shuffleReaddir(t);
    const context = { cwd: root, workspaceRoot: root };
    const expected = directoryOracle(context);
    const count = countLeafStats(t, root);
    assert.deepEqual(await listWorkspaceDirectory(context), expected);
    assert.equal(count.sync + count.async, 0);
    t.mock.method(fs, 'mkdirSync', () => { throw new Error('unexpected mkdirSync'); });
    for (const [body, status, expectedBody] of [
        ['{"path":"docs/new"}', 201, { ok: true, path: 'docs/new' }],
        ['{"path":"docs/new"}', 409, { ok: false, error: 'directory_exists' }],
        ['{"path":"link/new"}', 400, { ok: false, error: 'invalid_directory' }],
        ['{"path":"missing/new"}', 400, { ok: false, error: 'invalid_parent' }]
    ]) {
        const res = response();
        await handleWorkspaceDirectoriesPost(Readable.from([Buffer.from(body)]), res, context);
        assert.equal(res.status, status);
        assert.deepEqual(res.body, expectedBody);
    }
});

test('async directories handle empty and 20000-entry boundaries without per-entry stats', async (t) => {
    const root = fixture(t, 'directory-boundaries');
    const context = { cwd: root, workspaceRoot: root };
    assert.deepEqual(await listWorkspaceDirectory(context), { path: '', parentPath: null, entries: [] });
    for (let index = 0; index < 20000; index += 1) {
        fs.writeFileSync(path.join(root, `file-${String(index).padStart(5, '0')}`), 'x');
    }
    const count = countLeafStats(t, root);
    const listing = await listWorkspaceDirectory(context);
    assert.equal(listing.entries.length, 20000);
    assert.equal(listing.entries[0].name, 'file-00000');
    assert.equal(listing.entries.at(-1).name, 'file-19999');
    assert.equal(count.sync + count.async, 0);
    for (const requestedPath of ['missing', '../outside']) {
        const res = response();
        const url = new URL('http://localhost/webchat/directories');
        url.searchParams.set('path', requestedPath);
        await handleWorkspaceDirectoriesGet({}, res, url, context);
        assert.equal(res.status, 400);
        assert.deepEqual(res.body, { ok: false, error: 'invalid_directory' });
    }
});

test('async suggestions match twelve folder/leaf queries with bounded stat work over 5000 entries', async (t) => {
    const root = fixture(t, 'suggestions-large');
    const outside = fixture(t, 'outside');
    for (let index = 0; index < 5000; index += 1) {
        fs.writeFileSync(path.join(root, `file-${String(index).padStart(4, '0')}.txt`), 'x');
    }
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'notes.txt'), 'notes');
    fs.writeFileSync(path.join(root, '.secrets'), 'reserved');
    fs.symlinkSync(path.join(root, 'docs'), path.join(root, 'inside-link'));
    fs.symlinkSync(outside, path.join(root, 'escape-link'));
    shuffleReaddir(t);
    const cases = [['', ''], ['', 'file'], ['', 'file-0'], ['', '-1'], ['', '.txt'], ['', 'docs'],
        ['', 'link'], ['docs', ''], ['docs', 'no'], ['inside-link', ''], ['missing', ''], ['', 'x'.repeat(4096)]];
    const expected = cases.map(([folder, leaf]) => suggestions.listWorkspaceSuggestions({
        workspaceRoot: root, base: root, folder, leaf, limit: 31
    }));
    const count = countLeafStats(t, root);
    for (let index = 0; index < cases.length; index += 1) {
        const [folder, leaf] = cases[index];
        assert.deepEqual(await suggestAsync({ workspaceRoot: root, base: root, folder, leaf, limit: 31 }),
            expected[index], `${folder}/${leaf}`);
    }
    assert.equal(count.sync, 0, 'the suggestion reader must not lstat synchronously');
    assert.ok(count.maxInFlight <= 8, `observed ${count.maxInFlight} in flight`);
    const before = count.async;
    const result = await suggestAsync({ workspaceRoot: root, base: root, leaf: 'file', limit: 30 });
    assert.equal(result.items.length, 30);
    assert.ok(count.async - before <= 60, `observed ${count.async - before} stats for 30 results`);
});

test('async suggestions retain default Unicode, case and accent ordering rather than base sensitivity', async (t) => {
    const root = fixture(t, 'suggestions-unicode');
    for (const name of ['a', 'A', 'á', 'ä', 'Á', 'alpha', 'Alpha', 'Ω', '.visible', 'aa']) {
        fs.writeFileSync(path.join(root, name), 'x');
    }
    shuffleReaddir(t);
    const args = { workspaceRoot: root, base: root, limit: 30 };
    const expected = suggestions.listWorkspaceSuggestions(args);
    const count = countLeafStats(t, root);
    assert.deepEqual(await suggestAsync(args), expected);
    assert.equal(count.sync, 0);
});

test('async suggestions refill after broken and escaping symlinks and preserve FIFO and inside-link metadata', async (t) => {
    const root = fixture(t, 'suggestions-special');
    const outside = fixture(t, 'suggestions-outside');
    fs.writeFileSync(path.join(root, 'zz-target'), 'inside');
    fs.symlinkSync(outside, path.join(root, 'aa-escape'));
    fs.symlinkSync(path.join(root, 'missing'), path.join(root, 'ab-broken'));
    fs.symlinkSync(path.join(root, 'zz-target'), path.join(root, 'ac-inside'));
    execFileSync('mkfifo', [path.join(root, 'ad-fifo')]);
    fs.writeFileSync(path.join(root, 'ae-file'), 'file');
    const args = { workspaceRoot: root, base: root, limit: 3 };
    const expected = suggestions.listWorkspaceSuggestions(args);
    assert.equal(expected.items.length, 3);
    assert.deepEqual(expected.items.map(({ label }) => label), ['ac-inside', 'ad-fifo', 'ae-file']);
    const count = countLeafStats(t, root);
    assert.deepEqual(await suggestAsync(args), expected);
    assert.equal(count.sync, 0);
    assert.ok(count.maxInFlight <= 8);
});

test('async suggestions rerank only accepted items after a Dirent kind changes before lstat', async (t) => {
    const root = fixture(t, 'suggestions-race');
    fs.writeFileSync(path.join(root, 'a-file'), 'a');
    fs.mkdirSync(path.join(root, 'z-folder'));
    const read = fs.promises.readdir;
    t.mock.method(fs.promises, 'readdir', async (...args) => {
        const entries = await read(...args);
        fs.rmdirSync(path.join(root, 'z-folder'));
        fs.writeFileSync(path.join(root, 'z-folder'), 'now-file');
        return entries;
    });
    const count = countLeafStats(t, root);
    const result = await suggestAsync({ workspaceRoot: root, base: root, limit: 2 });
    assert.deepEqual(result.items.map(({ kind, label }) => ({ kind, label })), [
        { kind: 'file', label: 'a-file' }, { kind: 'file', label: 'z-folder' }
    ]);
    assert.equal(result.items[1].size, 8);
    assert.equal(count.sync, 0);
});

test('async suggestions return immediately for zero and negative limits without filesystem calls', async (t) => {
    const root = fixture(t, 'suggestions-zero');
    fs.writeFileSync(path.join(root, 'file'), 'x');
    let calls = 0;
    for (const method of ['realpathSync', 'lstatSync', 'readdirSync']) {
        t.mock.method(fs, method, () => { calls += 1; throw new Error(`unexpected ${method}`); });
    }
    for (const method of ['realpath', 'lstat', 'readdir']) {
        t.mock.method(fs.promises, method, () => { calls += 1; throw new Error(`unexpected ${method}`); });
    }
    for (const limit of [0, -1]) {
        assert.deepEqual(await suggestAsync({ workspaceRoot: root, base: root, limit }), { ok: true, items: [] });
    }
    assert.equal(calls, 0, 'zero and negative limits must not begin root resolution or a scan');
});

test('async workspace paths mirror sync errors and results for symlinks, missing paths and escapes', async (t) => {
    const root = fixture(t, 'path-parity');
    const outside = fixture(t, 'path-outside');
    fs.mkdirSync(path.join(root, 'docs'));
    fs.symlinkSync(path.join(root, 'docs'), path.join(root, 'inside'));
    fs.symlinkSync(outside, path.join(root, 'escape'));
    const cases = ['', null, '\0', '.', 'docs', 'inside/new/deep', 'missing/deep', '../outside',
        'escape', 'escape/missing', '/docs', 'Ω/á', '  ', outside];
    const matrix = [];
    for (const leadingSlashIsWorkspaceRelative of [true, false]) {
        for (const input of cases) {
            const options = { workspaceRoot: root, leadingSlashIsWorkspaceRelative };
            let value;
            let error;
            try { value = paths.resolveWorkspacePath(input, options); } catch (caught) { error = caught.message; }
            matrix.push({ input, options, value, error });
        }
    }
    forbidSyncPathReads(t);
    for (const { input, options, value, error } of matrix) {
        if (error) await assert.rejects(async () => pathAsync(input, options), { message: error });
        else assert.equal(await pathAsync(input, options), value);
    }
});

test('async workspace base and suggestion handler preserve selected-base confinement and responses', async (t) => {
    const root = fixture(t, 'handler');
    const outside = fixture(t, 'handler-outside');
    fs.mkdirSync(path.join(root, 'project', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'project', 'README.md'), 'readme');
    fs.symlinkSync(outside, path.join(root, 'escape'));
    const selected = new URL('http://localhost/webchat/suggestions/files?workspace-dir=project&query=');
    const expectedBase = suggestions.resolveWebchatWorkspaceBase(selected, { workspaceRoot: root });
    forbidSyncPathReads(t);
    assert.deepEqual(await baseAsync(selected, { workspaceRoot: root }), expectedBase);
    for (const dir of ['escape', 'escape/missing', '../outside', '']) {
        const url = new URL('http://localhost/webchat');
        url.searchParams.set('workspace-dir', dir);
        await assert.rejects(async () => baseAsync(url, { workspaceRoot: root }),
            { message: 'Invalid WebChat workspace directory.' });
    }
    const res = response();
    await suggestions.handleSuggestionsFiles({}, res, selected, { workspaceRoot: root });
    assert.equal(res.status, 200);
    assert.equal(res.body.root, '');
    assert.deepEqual(res.body.items.map(({ path: itemPath, workspacePath, queryPath }) =>
        ({ path: itemPath, workspacePath, queryPath })), [
        { path: 'docs', workspacePath: 'project/docs', queryPath: 'docs' },
        { path: 'README.md', workspacePath: 'project/README.md', queryPath: 'README.md' }
    ]);
    const invalid = response();
    const queryUrl = new URL('http://localhost/webchat/suggestions/files?query=../escape');
    await suggestions.handleSuggestionsFiles({}, invalid, queryUrl, { workspaceRoot: root });
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.body, { ok: false, error: 'invalid_query' });
});
