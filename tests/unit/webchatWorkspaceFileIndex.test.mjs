import assert from 'node:assert/strict';
import test from 'node:test';

import { parseWorkspaceFilesPayload } from '../../cli/server/webchat/network.js';
import { createWorkspaceFileIndex } from '../../cli/server/webchat/workspaceFileIndex.js';

test('workspace file index applies snapshots and changed deltas', () => {
    const index = createWorkspaceFileIndex();
    assert.equal(index.has('README.md'), false);
    assert.equal(index.applyUpdate({
        indexVersion: 1,
        reset: true,
        files: ['README.md', 'src/index.mjs'],
    }), true);
    assert.equal(index.has('README.md'), true);
    assert.equal(index.has('missing.md'), false);

    assert.equal(index.applyUpdate({
        indexVersion: 2,
        reset: false,
        added: ['reports/final.md'],
        removed: ['src/index.mjs'],
    }), true);
    assert.deepEqual(index.snapshot(), {
        indexVersion: 2,
        ready: true,
        files: ['README.md', 'reports/final.md'],
    });
    assert.equal(index.applyUpdate({
        indexVersion: 2,
        reset: false,
        added: ['stale.md'],
        removed: [],
    }), false);

    assert.equal(index.applyUpdate({
        indexVersion: 1,
        reset: true,
        files: ['new-runtime.md'],
    }), true);
    assert.deepEqual(index.snapshot(), {
        indexVersion: 1,
        ready: true,
        files: ['new-runtime.md'],
    });
});

test('workspace file payload parser accepts only snapshots or deltas with a version', () => {
    assert.deepEqual(parseWorkspaceFilesPayload(JSON.stringify({
        indexVersion: 3,
        reset: true,
        files: ['README.md'],
    })), {
        indexVersion: 3,
        reset: true,
        files: ['README.md'],
    });
    assert.equal(parseWorkspaceFilesPayload('{"reset":true,"files":[]}'), null);
    assert.equal(parseWorkspaceFilesPayload('{"indexVersion":1,"reset":false}'), null);
});
