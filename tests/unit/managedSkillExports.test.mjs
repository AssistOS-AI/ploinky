import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncManagedSkillExports, skillTreeDigest } from '../../cli/utils/skills/managedExports.js';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-skills-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'source');
    const folder = path.join(root, 'target');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'SKILL.md'), '# one\n');
    fs.writeFileSync(path.join(source, 'helper.sh'), 'echo one\n');
    fs.chmodSync(path.join(source, 'helper.sh'), 0o755);
    const sources = [{ name: 'demo', path: source, source: { name: 'fixture' } }];
    const sync = (options = {}) => syncManagedSkillExports({ folder, owner: 'manifest', sources, ...options });
    const output = path.join(folder, '.agents', 'skills', 'demo');
    return { root, source, folder, sources, sync, output };
}

test('owned export detects helper bytes, modes and membership, is idempotent, and removes final output', t => {
    const { source, output, sync } = fixture(t);
    assert.deepEqual(sync().installed, ['demo']);
    assert.deepEqual(sync().unchanged, ['demo']);
    const helper = path.join(source, 'helper.sh');
    const before = fs.statSync(helper);
    fs.writeFileSync(helper, 'echo two\n');
    fs.utimesSync(helper, before.atime, before.mtime);
    assert.deepEqual(sync().installed, ['demo']);
    assert.equal(fs.readFileSync(path.join(output, 'helper.sh'), 'utf8'), 'echo two\n');
    fs.chmodSync(helper, 0o644);
    sync();
    assert.equal(fs.statSync(path.join(output, 'helper.sh')).mode & 0o777, 0o644);
    fs.unlinkSync(helper);
    sync();
    assert.equal(fs.existsSync(path.join(output, 'helper.sh')), false);
    assert.deepEqual(sync({ sources: [] }).removed, ['demo']);
    assert.equal(fs.existsSync(output), false);
});

test('edited files, added files and executable mode edits preserve managed output and ownership proof', t => {
    const { source, output, sync } = fixture(t);
    sync();
    fs.writeFileSync(path.join(output, 'helper.sh'), 'my edits\n');
    fs.writeFileSync(path.join(source, 'SKILL.md'), '# two\n');
    assert.equal(sync().diagnostics[0].reason, 'edited-output-preserved');
    assert.equal(sync({ sources: [] }).diagnostics[0].reason, 'edited-output-preserved');
    assert.equal(fs.readFileSync(path.join(output, 'helper.sh'), 'utf8'), 'my edits\n');
    assert.equal(fs.readFileSync(path.join(output, 'SKILL.md'), 'utf8'), '# one\n');
});

test('unrecorded same-name output is never adopted and explicit deletion is not undone', t => {
    const { output, sync } = fixture(t);
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'SKILL.md'), 'local');
    assert.equal(sync().diagnostics[0].reason, 'unrecorded-output-preserved');
    fs.rmSync(output, { recursive: true });
    sync();
    fs.rmSync(output, { recursive: true });
    assert.equal(sync().diagnostics[0].reason, 'removed-output-preserved');
    assert.equal(fs.existsSync(output), false);
});

test('concurrent edits before and after moving ownership output are preserved', t => {
    const { source, output, sync } = fixture(t);
    sync();
    fs.writeFileSync(path.join(source, 'SKILL.md'), '# two\n');
    const result = sync({ beforeMove: ({ destination }) => fs.writeFileSync(path.join(destination, 'helper.sh'), 'racing edit') });
    assert.equal(result.diagnostics[0].reason, 'concurrent-edit-preserved');
    assert.equal(fs.readFileSync(path.join(output, 'helper.sh'), 'utf8'), 'racing edit');
});

test('an open file descriptor continues to reference retained output after replacement', t => {
    const { source, output, sync } = fixture(t);
    sync();
    const fd = fs.openSync(path.join(output, 'helper.sh'), 'r+');
    t.after(() => fs.closeSync(fd));
    fs.writeFileSync(path.join(source, 'SKILL.md'), '# two\n');
    const result = sync();
    fs.writeSync(fd, 'late edit');
    assert.equal(fs.readFileSync(path.join(result.backups[0], 'helper.sh'), 'utf8'), 'late edit');
    assert.equal(skillTreeDigest(source), skillTreeDigest(output));
});

test('duplicate names and symlinked output roots fail without changing unrelated paths', t => {
    const { root, source, folder, sources, sync } = fixture(t);
    assert.throws(() => sync({ sources: [...sources, ...sources] }), /Duplicate/);
    fs.mkdirSync(folder);
    fs.symlinkSync(source, path.join(folder, '.agents'));
    assert.throws(() => sync(), /real directory/);
    assert.deepEqual(fs.readdirSync(source).sort(), ['SKILL.md', 'helper.sh']);
    assert.equal(fs.existsSync(path.join(root, 'target', '.agents', 'skills')), false);
});

test('prototype-shaped names remain data and another exporter cannot replace owned content', t => {
    const { sources, output, sync } = fixture(t);
    sync();
    assert.equal(sync({ owner: 'defaults:other' }).diagnostics[0].reason, 'owned-by-other-export');
    assert.deepEqual(sync({ sources: [{ ...sources[0], name: 'constructor' }] }).installed, ['constructor']);
    assert.equal(fs.existsSync(output), false);
});
