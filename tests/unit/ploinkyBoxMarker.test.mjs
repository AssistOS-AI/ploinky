import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BOX_MARKER_CONTENT } from '../../ploinky-box/constants.mjs';
import { isInsideBox } from '../../ploinky-box/lib/boxMarker.mjs';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-marker-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, marker: path.join(root, 'ploinky-box') };
}

test('only the exact semantic image marker identifies the in-box environment', (t) => {
    const state = fixture(t);
    assert.equal(isInsideBox({ markerPath: state.marker }), false);

    fs.writeFileSync(state.marker, BOX_MARKER_CONTENT);
    assert.equal(isInsideBox({ markerPath: state.marker }), true);

    fs.writeFileSync(state.marker, 'wrong\n');
    assert.throws(() => isInsideBox({ markerPath: state.marker }), (error) => (
        error.code === 'PLOINKY_BOX_MARKER_INVALID'
            && /destroy and recreate/i.test(error.message)
    ));
});

test('symlinked and multiply-linked markers fail closed', (t) => {
    const state = fixture(t);
    const target = path.join(state.root, 'target');
    fs.writeFileSync(target, BOX_MARKER_CONTENT);
    fs.symlinkSync(target, state.marker);
    assert.throws(() => isInsideBox({ markerPath: state.marker }), /single regular file/);

    fs.unlinkSync(state.marker);
    fs.linkSync(target, state.marker);
    assert.throws(() => isInsideBox({ markerPath: state.marker }), /single regular file/);
});
