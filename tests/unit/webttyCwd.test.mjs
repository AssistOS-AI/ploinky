import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    createWorkspaceDirectoryResolver,
    normalizeCwdRelative,
    resolveWorkspaceDirectory,
} from '../../core-services/webtty/cwd.mjs';

function fixture(t) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-webtty-cwd-'));
    const root = path.join(parent, 'workspace');
    const outside = path.join(parent, 'outside');
    fs.mkdirSync(path.join(root, 'src', 'api'), { recursive: true });
    fs.mkdirSync(path.join(root, 'spaces and ünicode'), { recursive: true });
    fs.mkdirSync(path.join(root, '%2e%2e'), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(root, 'file.txt'), 'not a directory');
    fs.symlinkSync(outside, path.join(root, 'escape'));
    t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
    return { root, outside };
}

test('root and nested directories resolve through realpath containment', (t) => {
    const { root } = fixture(t);
    const resolve = createWorkspaceDirectoryResolver({ workspaceRoot: root });
    assert.equal(resolve().relativePath, '');
    assert.equal(resolve('').absolutePath, fs.realpathSync(root));
    assert.equal(resolve('.').absolutePath, fs.realpathSync(root));
    assert.equal(resolve('src//api/').relativePath, 'src/api');
    assert.equal(resolve('spaces and ünicode').absolutePath, fs.realpathSync(path.join(root, 'spaces and ünicode')));
    assert.equal(resolve('%2e%2e').relativePath, '%2e%2e', 'JSON values are never percent-decoded again');
});

test('absolute, ambiguous, traversal, malformed, missing, file, and escaping requests fail', (t) => {
    const { root } = fixture(t);
    const vectors = [
        '/etc',
        '//server/share',
        'C:/Windows',
        'C:relative',
        '..',
        'src/../api',
        'src\\api',
        'nul\0byte',
        '\uD800',
        'missing',
        'file.txt',
        'escape',
    ];
    for (const value of vectors) {
        assert.throws(
            () => resolveWorkspaceDirectory(value, { workspaceRoot: root }),
            (error) => error.code === 'WEBTTY_CWD_INVALID',
            value,
        );
    }
    assert.throws(() => normalizeCwdRelative(42));
    assert.throws(() => normalizeCwdRelative('x'.repeat(4097)));
});

test('worker-side revalidation catches replacement after Router validation', (t) => {
    const { root, outside } = fixture(t);
    const selected = path.join(root, 'src', 'api');
    assert.equal(resolveWorkspaceDirectory('src/api', { workspaceRoot: root }).relativePath, 'src/api');
    fs.rmdirSync(selected);
    fs.symlinkSync(outside, selected);
    assert.throws(
        () => resolveWorkspaceDirectory('src/api', { workspaceRoot: root }),
        (error) => error.category === 'containment',
    );
});
