import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { assertDataLayoutCurrent, readDataLayoutVersion } from '../../cli/utils/workspaceDataLayout.js';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'current-data-layout-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}
test('fresh workspace initializes layout 4 and repeated admission leaves data untouched', t => {
    const root = fixture(t);
    assert.equal(assertDataLayoutCurrent(root), 4);
    const marker = path.join(root, '.data', '.layout.json');
    const before = fs.statSync(marker).ino;
    assert.deepEqual(fs.readdirSync(path.join(root, '.data')).sort(), ['.layout.json', 'agents']);
    assert.equal(assertDataLayoutCurrent(root), 4);
    assert.equal(fs.statSync(marker).ino, before);
    assert.equal(readDataLayoutVersion(root), 4);
});
for (const version of [1, 2, 3, 5]) {
    test(`unsupported layout ${version} is rejected without moving or rewriting data`, t => {
        const root = fixture(t);
        fs.mkdirSync(path.join(root, '.data', 'old-home'), { recursive: true });
        fs.writeFileSync(path.join(root, '.data', 'old-home', 'log'), 'keep');
        const marker = path.join(root, '.data', '.layout.json');
        fs.writeFileSync(marker, JSON.stringify({ version }));
        assert.throws(() => assertDataLayoutCurrent(root), /Unsupported workspace data layout/);
        assert.equal(JSON.parse(fs.readFileSync(marker)).version, version);
        assert.equal(fs.readFileSync(path.join(root, '.data', 'old-home', 'log'), 'utf8'), 'keep');
        assert.equal(fs.existsSync(path.join(root, '.data', 'agents')), false);
    });
}
test('unversioned existing stores and linked paths are not treated as fresh workspaces', t => {
    const root = fixture(t);
    fs.mkdirSync(path.join(root, '.data', 'old-home'), { recursive: true });
    assert.throws(() => assertDataLayoutCurrent(root), /Unsupported/);
    fs.rmdirSync(path.join(root, '.data', 'old-home'));
    fs.symlinkSync('/tmp', path.join(root, '.data', 'agents'));
    assert.throws(() => assertDataLayoutCurrent(root), /unsafe storage path/);
    assert.equal(fs.existsSync(path.join(root, '.data', '.layout.json')), false);
});
