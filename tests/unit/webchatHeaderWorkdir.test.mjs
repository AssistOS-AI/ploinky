import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWorkspaceDirectoryUrl, initDom } from '../../cli/server/webchat/domSetup.js';

test('working directory links use the configured workspace UI and workspace-relative Explorer path', () => {
    const root = '/Users/adrianganga/Desktop/devWorkNou/workspace';
    assert.equal(buildWorkspaceDirectoryUrl(`${root}/testroboteam`, root), '/#file-exp/testroboteam');
    assert.equal(buildWorkspaceDirectoryUrl(root, root), '/#file-exp/');
    assert.equal(buildWorkspaceDirectoryUrl(`${root}/My Space/ă#100%? & `, root), '/#file-exp/My%20Space/%C4%83%23100%25%3F%20%26%20');
});

test('working directory links reject outside roots, traversal and malformed paths', () => {
    const root = '/workspace';
    for (const directory of ['/workspace-other/project', '/outside/project', '/workspace/../escape', '/workspace/./project',
        '/workspace//project', '/workspace/project\n', '/workspace/project\\escape', '/workspace/\ud800']) {
        assert.equal(buildWorkspaceDirectoryUrl(directory, root), null, directory);
    }
    assert.equal(buildWorkspaceDirectoryUrl('/workspace', ''), null);
    assert.equal(buildWorkspaceDirectoryUrl('/workspace', '/'), null);
});

test('header initializes a safe link with the complete directory and an accessible label', (t) => {
    const previousDocument = globalThis.document;
    const previousWindow = globalThis.window;
    t.after(() => {
        globalThis.document = previousDocument;
        globalThis.window = previousWindow;
    });
    const attributes = new Map();
    const link = { setAttribute: (name, value) => attributes.set(name, value) };
    const workdir = '/workspace/<b>"quoted" & folder ';
    globalThis.document = {
        body: { dataset: { workdir, workspaceRoot: '/workspace' }, setAttribute() {} },
        getElementById: (id) => id === 'headerWorkdir' ? link : null,
        querySelector: () => null,
    };
    globalThis.window = { location: { search: '' } };
    initDom();
    assert.equal(link.textContent, workdir);
    assert.equal(link.href, '/#file-exp/%3Cb%3E%22quoted%22%20%26%20folder%20');
    assert.equal(link.title, `Open in Explorer: ${workdir}`);
    assert.equal(attributes.get('aria-label'), `Open working directory in Explorer: ${workdir} (new tab)`);
});
