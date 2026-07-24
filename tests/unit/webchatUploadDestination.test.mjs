import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildUploadSelectionRoots,
    joinUploadPath,
} from '../../cli/server/webchat/uploadDestinationDialog.js';
import { buildAttachmentUploadHeaders } from '../../cli/server/webchat/network.js';

test('upload destination paths join without exposing absolute separators', () => {
    assert.equal(joinUploadPath('', 'report.pdf'), 'report.pdf');
    assert.equal(joinUploadPath('/incoming/', '/docs/report.pdf'), 'incoming/docs/report.pdf');
    assert.equal(joinUploadPath('assets\\images', 'photo.jpg'), 'assets/images/photo.jpg');
});

test('file selections expose one collision root per selected filename', () => {
    const roots = buildUploadSelectionRoots([
        { relativePath: 'first.txt' },
        { relativePath: 'second.txt' },
    ], 'file');
    assert.deepEqual(roots, [
        { name: 'first.txt', kind: 'file' },
        { name: 'second.txt', kind: 'file' },
    ]);
});

test('folder selections preserve a single top-level folder collision root', () => {
    const roots = buildUploadSelectionRoots([
        { relativePath: 'docs/one.md' },
        { relativePath: 'docs/nested/two.md' },
    ], 'folder');
    assert.deepEqual(roots, [{ name: 'docs', kind: 'folder' }]);
});

test('attachment requests carry the selected destination and explicit overwrite decision', () => {
    const headers = buildAttachmentUploadHeaders({
        file: { name: 'note.md', type: 'text/markdown' },
        relativePath: 'docs/note.md',
        destinationPath: 'incoming files',
        overwrite: true,
    });
    assert.equal(decodeURIComponent(headers['X-Destination-Path']), 'incoming files');
    assert.equal(decodeURIComponent(headers['X-Relative-Path']), 'docs/note.md');
    assert.equal(headers['X-Overwrite'], '1');
    assert.equal(headers['Content-Type'], 'text/markdown');
});
