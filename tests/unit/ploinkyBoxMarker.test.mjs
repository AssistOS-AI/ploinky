import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isInsideBox } from '../../ploinky-box/lib/boxMarker.mjs';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-marker-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, marker: path.join(root, 'ploinky-box') };
}

test('only the exact contract-6 image marker identifies the in-box environment', (t) => {
    const state = fixture(t);
    assert.equal(isInsideBox({ markerPath: state.marker }), false);

    fs.writeFileSync(state.marker, '6\n');
    assert.equal(isInsideBox({ markerPath: state.marker }), true);

    fs.writeFileSync(state.marker, '5\n');
    assert.throws(() => isInsideBox({ markerPath: state.marker }), (error) => (
        error.code === 'PLOINKY_BOX_MARKER_INVALID'
            && /destroy and recreate/i.test(error.message)
    ));
});

test('symlinked and multiply-linked markers fail closed', (t) => {
    const state = fixture(t);
    const target = path.join(state.root, 'target');
    fs.writeFileSync(target, '6\n');
    fs.symlinkSync(target, state.marker);
    assert.throws(() => isInsideBox({ markerPath: state.marker }), /single regular file/);

    fs.unlinkSync(state.marker);
    fs.linkSync(target, state.marker);
    assert.throws(() => isInsideBox({ markerPath: state.marker }), /single regular file/);
});
