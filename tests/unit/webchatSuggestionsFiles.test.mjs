import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    resolveWebchatWorkspaceBase,
    sanitizeSuggestionQuery,
    listWorkspaceSuggestions
} from '../../cli/server/handlers/webchat/workspaceSuggestions.js';
import {
    applyWorkspacePathSelectionToValue,
    createWorkspacePathsProvider
} from '../../cli/server/webchat/autocompleteProviders/workspacePaths.js';

function makeWorkspace(prefix) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `webchat-suggest-${prefix}-`));
    return root;
}

test('sanitizeSuggestionQuery rejects absolute paths, traversal, and NUL bytes', () => {
    assert.equal(sanitizeSuggestionQuery('/etc/passwd'), null);
    assert.equal(sanitizeSuggestionQuery('../escape'), null);
    assert.equal(sanitizeSuggestionQuery('inside/../outside'), null);
    assert.equal(sanitizeSuggestionQuery('with\0nul'), null);
});

test('sanitizeSuggestionQuery splits folder/leaf and accepts safe values', () => {
    assert.deepEqual(sanitizeSuggestionQuery('docs'), { folder: '', leaf: 'docs' });
    assert.deepEqual(sanitizeSuggestionQuery('docs/notes'), { folder: 'docs', leaf: 'notes' });
    assert.deepEqual(sanitizeSuggestionQuery(''), { folder: '', leaf: '' });
});

test('listWorkspaceSuggestions returns folders before files and excludes secrets', () => {
    const root = makeWorkspace('listing');
    try {
        fs.mkdirSync(path.join(root, 'docs'));
        fs.mkdirSync(path.join(root, '.git'));
        fs.mkdirSync(path.join(root, '.ploinky'));
        fs.writeFileSync(path.join(root, 'notes.md'), 'hello');
        fs.writeFileSync(path.join(root, 'README.md'), 'readme');
        fs.writeFileSync(path.join(root, '.secrets'), 'never');
        fs.writeFileSync(path.join(root, 'config.secrets'), 'never');
        const result = listWorkspaceSuggestions({
            workspaceRoot: root,
            base: root,
            folder: '',
            leaf: '',
            limit: 10
        });
        assert.equal(result.ok, true);
        const labels = result.items.map((entry) => `${entry.kind}:${entry.label}`);
        assert.ok(labels[0].startsWith('folder:docs'), `expected folder first, got ${labels.join(',')}`);
        assert.ok(!labels.includes('file:.secrets'), 'must not expose .secrets');
        assert.ok(!labels.includes('file:config.secrets'), 'must not expose *.secrets');
        assert.ok(labels.includes('folder:.git'), 'must allow normal dot folders like .git');
        assert.ok(!labels.includes('folder:.ploinky'), 'must hide Ploinky runtime state');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('listWorkspaceSuggestions searches nested paths for bare @ tokens', () => {
    const root = makeWorkspace('recursive');
    try {
        fs.mkdirSync(path.join(root, 'ploinky', 'cli'), { recursive: true });
        fs.mkdirSync(path.join(root, 'ploinky', 'bin'), { recursive: true });
        fs.mkdirSync(path.join(root, 'ploinky', '.git'), { recursive: true });
        fs.mkdirSync(path.join(root, 'other'), { recursive: true });
        fs.writeFileSync(path.join(root, 'ploinky', '.npmrc'), 'cache=.npm');
        fs.writeFileSync(path.join(root, 'ploinky', 'README.md'), 'readme');
        const result = listWorkspaceSuggestions({
            workspaceRoot: root,
            base: root,
            folder: '',
            leaf: 'plo',
            limit: 10
        });
        assert.equal(result.ok, true);
        const displayPaths = result.items.map((entry) => entry.displayPath);
        assert.ok(displayPaths.includes('ploinky'));
        assert.ok(displayPaths.includes('ploinky/cli'));
        assert.ok(displayPaths.includes('ploinky/bin'));
        assert.ok(displayPaths.includes('ploinky/.git'));
        assert.ok(!displayPaths.includes('other'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('listWorkspaceSuggestions ranks prefix path matches before substring matches', () => {
    const root = makeWorkspace('ranking');
    try {
        fs.mkdirSync(path.join(root, 'AssistOSExplorer'), { recursive: true });
        fs.mkdirSync(path.join(root, 'ploinky', 'cli'), { recursive: true });
        const result = listWorkspaceSuggestions({
            workspaceRoot: root,
            base: root,
            folder: '',
            leaf: 'plo',
            limit: 3
        });
        assert.equal(result.ok, true);
        assert.equal(result.items[0]?.displayPath, 'ploinky');
        assert.ok(result.items.map((entry) => entry.displayPath).includes('ploinky/cli'));
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('listWorkspaceSuggestions confines results to the workspace and rejects symlink escapes', () => {
    const root = makeWorkspace('symlink');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-outside-'));
    try {
        fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
        try {
            fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape'));
        } catch (err) {
            if (err.code === 'EPERM' || err.code === 'EACCES') {
                return; // platform without symlink support — skip.
            }
            throw err;
        }
        const result = listWorkspaceSuggestions({
            workspaceRoot: root,
            base: root,
            folder: '',
            leaf: '',
            limit: 10
        });
        const labels = result.items.map((entry) => entry.label);
        assert.ok(!labels.includes('escape'), 'must drop symlinks that escape the workspace');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('listWorkspaceSuggestions filters results by leaf query', () => {
    const root = makeWorkspace('filter');
    try {
        fs.writeFileSync(path.join(root, 'apple.txt'), 'a');
        fs.writeFileSync(path.join(root, 'banana.txt'), 'b');
        fs.writeFileSync(path.join(root, 'apricot.md'), 'c');
        const result = listWorkspaceSuggestions({
            workspaceRoot: root,
            base: root,
            folder: '',
            leaf: 'ap',
            limit: 10
        });
        const labels = result.items.map((entry) => entry.label).sort();
        assert.deepEqual(labels, ['apple.txt', 'apricot.md']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('resolveWebchatWorkspaceBase supports confined legacy dir parameter', () => {
    const root = makeWorkspace('compat-dir');
    const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    try {
        fs.mkdirSync(path.join(root, 'project'));
        process.env.PLOINKY_WORKSPACE_ROOT = root;
        const parsed = new URL(
            `/webchat?agent=achilles-cli&dir=${encodeURIComponent(path.join(root, 'project'))}`,
            'http://127.0.0.1'
        );
        const base = resolveWebchatWorkspaceBase(parsed);
        assert.equal(base.base, fs.realpathSync(path.join(root, 'project')));
        assert.equal(base.relativeBase, 'project');
    } finally {
        if (previousRoot === undefined) {
            delete process.env.PLOINKY_WORKSPACE_ROOT;
        } else {
            process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
        }
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('resolveWebchatWorkspaceBase rejects legacy dir outside the workspace', () => {
    const root = makeWorkspace('compat-dir-reject');
    const outside = makeWorkspace('compat-dir-outside');
    const previousRoot = process.env.PLOINKY_WORKSPACE_ROOT;
    try {
        process.env.PLOINKY_WORKSPACE_ROOT = root;
        const parsed = new URL(
            `/webchat?agent=achilles-cli&dir=${encodeURIComponent(outside)}`,
            'http://127.0.0.1'
        );
        const base = resolveWebchatWorkspaceBase(parsed);
        assert.equal(base.base, fs.realpathSync(root));
        assert.equal(base.relativeBase, '');
    } finally {
        if (previousRoot === undefined) {
            delete process.env.PLOINKY_WORKSPACE_ROOT;
        } else {
            process.env.PLOINKY_WORKSPACE_ROOT = previousRoot;
        }
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(outside, { recursive: true, force: true });
    }
});

test('workspace path provider drills into selected folders using @file tokens', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url) => {
        calls.push(String(url));
        const query = new URL(String(url), 'http://127.0.0.1').searchParams.get('query');
        if (query === 'do') {
            return {
                ok: true,
                json: async () => ({ ok: true, items: [{ kind: 'folder', label: 'docs', path: 'docs' }] })
            };
        }
        if (query === 'docs/') {
            return {
                ok: true,
                json: async () => ({ ok: true, items: [{ kind: 'file', label: 'notes.md', path: 'docs/notes.md' }] })
            };
        }
        return { ok: true, json: async () => ({ ok: true, items: [] }) };
    };
    try {
        const provider = createWorkspacePathsProvider({ basePath: '/webchat' });
        const initialTrigger = { trigger: '@', triggerIndex: 0, token: 'do' };
        await provider.requestSuggestions('@do', initialTrigger);
        const [folder] = provider.getSuggestions('@do', 3, initialTrigger);
        assert.equal(folder.label, 'docs/');
        const folderSelection = folder.applySelection('@do', initialTrigger);
        assert.deepEqual(folderSelection, { value: '@file:docs/', cursor: 11 });

        const folderTrigger = { trigger: '@', triggerIndex: 0, token: 'file:docs/' };
        await provider.requestSuggestions(folderSelection.value, folderTrigger);
        const [file] = provider.getSuggestions(folderSelection.value, folderSelection.cursor, folderTrigger);
        assert.equal(file.label, 'docs/notes.md');
        assert.equal(file.group, 'Files and folders');
        assert.equal(new URL(calls[1], 'http://127.0.0.1').searchParams.get('query'), 'docs/');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('workspace path provider keeps nested display-path matches for bare @ search', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
            ok: true,
            items: [
                { kind: 'folder', label: 'ploinky', displayPath: 'ploinky', path: 'ploinky' },
                { kind: 'folder', label: 'cli', displayPath: 'ploinky/cli', path: 'ploinky/cli' },
            ]
        })
    });
    try {
        const provider = createWorkspacePathsProvider({ basePath: '/webchat' });
        const trigger = { trigger: '@', triggerIndex: 0, token: 'plo' };
        await provider.requestSuggestions('@plo', trigger);
        const suggestions = provider.getSuggestions('@plo', 4, trigger);
        assert.deepEqual(suggestions.map((entry) => entry.label), ['ploinky/', 'ploinky/cli/']);
        assert.deepEqual(suggestions.map((entry) => entry.group), ['Files and folders', 'Files and folders']);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('applyWorkspacePathSelectionToValue replaces the active @ token', () => {
    const result = applyWorkspacePathSelectionToValue('see @no then @later', 'docs/notes.md', 'file', {
        trigger: '@',
        triggerIndex: 4,
        token: 'no'
    });
    assert.deepEqual(result, {
        value: 'see @file:docs/notes.md then @later',
        cursor: 24
    });
});
