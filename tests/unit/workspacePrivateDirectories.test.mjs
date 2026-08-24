import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    WORKSPACE_PRIVATE_DIRECTORY_SEGMENTS,
    prepareWorkspacePrivateDirectories,
} from '../../cli/utils/runtime/workspacePrivateDirectories.js';

function fixture(t) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-private-directories-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.chmodSync(workspace, 0o755);
    fs.mkdirSync(path.join(workspace, '.ploinky'), { mode: 0o700 });
    return workspace;
}

test('start preflight creates and normalizes every private runtime directory to 0700', (t) => {
    const workspace = fixture(t);
    fs.mkdirSync(path.join(workspace, '.ploinky', 'running', 'no-wait'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.ploinky', 'logs', 'no-wait'), { recursive: true });
    for (const segments of WORKSPACE_PRIVATE_DIRECTORY_SEGMENTS) {
        fs.chmodSync(path.join(workspace, ...segments), 0o775);
    }

    const prepared = prepareWorkspacePrivateDirectories({ workspaceRoot: workspace });

    assert.equal(prepared.length, 4);
    for (const segments of WORKSPACE_PRIVATE_DIRECTORY_SEGMENTS) {
        assert.equal(fs.statSync(path.join(workspace, ...segments)).mode & 0o777, 0o700);
    }
});

test('start preflight rejects an insecure root or symlinked private directory', (t) => {
    const insecure = fixture(t);
    fs.chmodSync(insecure, 0o775);
    assert.throws(
        () => prepareWorkspacePrivateDirectories({ workspaceRoot: insecure }),
        /group- or other-writable/,
    );

    const linked = fixture(t);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-private-outside-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.symlinkSync(outside, path.join(linked, '.ploinky', 'running'));
    assert.throws(
        () => prepareWorkspacePrivateDirectories({ workspaceRoot: linked }),
        /not one regular directory/,
    );
});
