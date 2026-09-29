import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webchat-launch-directories-'));
process.env.PLOINKY_WORKSPACE_ROOT = root;
const { resolveWebchatLaunchOptions, buildWebchatQuery } = await import('../../cli/server/handlers/webchat/launchOptions.js');
const { resolveWebchatWorkspaceBase } = await import('../../cli/server/handlers/webchat/workspaceSuggestions.js');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('WebChat keeps the same selected directory in the page, CLI and subrequests', () => {
    for (const directory of ['projects/demo', 'projects/My folder & notes', '/projects/demo', 'achilles-cli']) {
        const url = new URL('http://localhost/webchat');
        url.searchParams.set('workspace-dir', directory);
        url.searchParams.set('robot', 'analyst');
        const expected = path.join(root, directory.replace(/^\/+/, ''));
        assert.equal(resolveWebchatWorkspaceBase(url).base, expected);
        assert.ok(resolveWebchatLaunchOptions(url).cliArgs.includes(`--dir=${expected}`));
        const stream = new URL(`http://localhost/webchat/stream?${buildWebchatQuery(url)}`);
        assert.equal(resolveWebchatWorkspaceBase(stream).base, expected);
        assert.deepEqual(resolveWebchatLaunchOptions(stream), resolveWebchatLaunchOptions(url));
    }
});

test('invalid or escaping directory selections fail instead of opening the workspace root', () => {
    fs.symlinkSync(os.tmpdir(), path.join(root, 'outside'));
    for (const directory of ['', '../other', 'outside/project', '\0']) {
        const url = new URL('http://localhost/webchat');
        url.searchParams.set('workspace-dir', directory);
        assert.throws(() => resolveWebchatWorkspaceBase(url), /Invalid WebChat workspace directory/);
        assert.throws(() => resolveWebchatLaunchOptions(url), /Invalid WebChat workspace directory/);
    }
});

test('legacy dir and workspace-dir cannot launch different folders for the same page', () => {
    const url = new URL('http://localhost/webchat');
    url.searchParams.set('workspace-dir', 'selected');
    url.searchParams.set('dir', root);
    assert.deepEqual(resolveWebchatLaunchOptions(url).cliArgs, [`--dir=${path.join(root, 'selected')}`]);
    assert.equal(resolveWebchatWorkspaceBase(url).base, path.join(root, 'selected'));
});
