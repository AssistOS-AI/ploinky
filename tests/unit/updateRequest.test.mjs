import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    formatUpdateRequestArgs,
    mapUpdateScope,
    parseUpdateRequest,
    resolveUpdateFolderScope,
} from '../../cli/commands/updateRequest.js';

function workspace(t) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'update-request-')));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const root = path.join(base, 'deep', 'workspace');
    fs.mkdirSync(path.join(root, 'projects', 'nested'), { recursive: true });
    fs.symlinkSync(root, path.join(base, 'alias'), 'dir');
    fs.mkdirSync(path.join(base, 'outside'));
    return { base, root, alias: path.join(base, 'alias') };
}

test('every update form is parsed once before mutation', t => {
    const { root } = workspace(t);
    const options = { cwd: root };
    assert.deepEqual(parseUpdateRequest([], options), { kind: 'all', folder: null, folderPath: null });
    assert.deepEqual(parseUpdateRequest(['ALL'], options), { kind: 'all', folder: null, folderPath: null });
    assert.deepEqual(parseUpdateRequest(['all', 'projects'], options),
        { kind: 'all', folder: 'projects', folderPath: path.join(root, 'projects') });
    assert.deepEqual(parseUpdateRequest(['projects/nested'], options),
        { kind: 'all', folder: 'projects/nested', folderPath: path.join(root, 'projects/nested') });
    assert.deepEqual(parseUpdateRequest(['repositories'], options), { kind: 'repos' });
    assert.deepEqual(parseUpdateRequest(['repository', 'Docs'], options), { kind: 'repo', repoName: 'Docs' });
    assert.deepEqual(parseUpdateRequest(['Docs'], options), { kind: 'repo', repoName: 'Docs' });
});

test('invalid forms are rejected with a usage error', t => {
    const { root } = workspace(t);
    const options = { cwd: root };
    assert.throws(() => parseUpdateRequest(['all', 'missing'], options), { code: 'PLOINKY_UPDATE_SCOPE_MISSING' });
    assert.throws(() => parseUpdateRequest(['all', 'projects', 'extra'], options), /trailing/);
    assert.throws(() => parseUpdateRequest(['repos', 'extra'], options), /trailing/);
    assert.throws(() => parseUpdateRequest(['repo'], options), /Usage/);
    assert.throws(() => parseUpdateRequest(['repo', 'a', 'b'], options), /trailing/);
    assert.throws(() => parseUpdateRequest(['Docs', 'extra'], options), /trailing/);
});

test('folder scope is contained canonically and mapped onto another workspace spelling', t => {
    const { base, root, alias } = workspace(t);
    const scope = resolveUpdateFolderScope(path.join(alias, 'projects', 'nested'), alias);
    assert.equal(scope.canonicalWorkspace, root);
    assert.equal(scope.relative, path.join('projects', 'nested'));
    assert.equal(mapUpdateScope(scope.relative, '/workspace'), '/workspace/projects/nested');
    assert.equal(mapUpdateScope(resolveUpdateFolderScope(root, alias).relative, '/workspace'), '/workspace');
    assert.throws(() => resolveUpdateFolderScope(path.join(base, 'outside'), root), { code: 'PLOINKY_UPDATE_SCOPE_OUTSIDE' });
    assert.throws(() => resolveUpdateFolderScope(path.join(root, 'nope'), root), { code: 'PLOINKY_UPDATE_SCOPE_MISSING' });
    assert.throws(() => mapUpdateScope('../x', '/workspace'), { code: 'PLOINKY_UPDATE_SCOPE_UNMAPPABLE' });
});

test('validated requests format canonical core argv', () => {
    assert.deepEqual(formatUpdateRequestArgs({ kind: 'all', folderPath: null }), ['update']);
    assert.deepEqual(formatUpdateRequestArgs({ kind: 'all', folderPath: '/workspace/p' }), ['update', 'all', '/workspace/p']);
    assert.deepEqual(formatUpdateRequestArgs({ kind: 'repos' }), ['update', 'repos']);
    assert.deepEqual(formatUpdateRequestArgs({ kind: 'repo', repoName: 'Docs' }), ['update', 'repo', 'Docs']);
});
