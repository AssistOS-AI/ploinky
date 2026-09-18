import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureRepositoryLink, installRepositoryLinks, removeRepositoryLinks } from '../../cli/utils/repositoryInstall.mjs';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-install-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'Docs');
    fs.mkdirSync(path.join(source, 'skills/example'), { recursive: true });
    fs.writeFileSync(path.join(source, 'skills/example/SKILL.md'), 'Original');
    return { root, source, options: { workspaceRoot: root, resolveRepository: name => {
        assert.equal(name, 'Docs'); return { source };
    } } };
}

test('mixed installation is additive, idempotent and live; explicit removal never follows links', t => {
    const { root, source, options } = fixture(t);
    const destination = path.join(root, 'robot');
    const input = { repos: [{ repoName: 'Docs', destination: path.join(destination, 'linked/docs') }],
        skillRepos: [{ repoName: 'Docs', destination, skills: ['example'] }] };
    const installed = installRepositoryLinks(input, options);
    assert.equal(installed.conflicts.length, 0);
    assert.equal(installed.results.length, 3);
    assert.ok(installRepositoryLinks(input, options).results.every(entry => entry.status === 'present'));
    assert.equal(fs.readlinkSync(path.join(destination, '.claude')), '.agents');
    fs.writeFileSync(path.join(source, 'skills/example/SKILL.md'), 'Updated');
    assert.equal(fs.readFileSync(path.join(destination, '.claude/skills/example/SKILL.md'), 'utf8'), 'Updated');
    installRepositoryLinks({ repos: [] }, options);
    const link = path.join(destination, '.agents/skills/example');
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(removeRepositoryLinks([link], options).results[0].status, 'removed');
    assert.ok(fs.existsSync(path.join(source, 'skills/example/SKILL.md')));
    assert.equal(removeRepositoryLinks([link], options).results[0].status, 'absent');
});

test('conflicts survive and removal accepts broken links but refuses ordinary directories', t => {
    const { root, options } = fixture(t);
    const destination = path.join(root, 'robot');
    fs.mkdirSync(path.join(destination, '.claude'), { recursive: true });
    const result = installRepositoryLinks({ skillRepos: [{ repoName: 'Docs', destination, skills: [] }] }, options);
    assert.equal(result.conflicts.length, 1);
    assert.equal(removeRepositoryLinks([path.join(destination, '.claude')], options).conflicts.length, 1);
    const broken = path.join(destination, 'broken');
    fs.symlinkSync('/nonexistent', broken);
    assert.equal(removeRepositoryLinks([broken], options).results[0].status, 'removed');
});

test('rejects escaping parent links and validates the entire batch before writing', t => {
    const { root, options } = fixture(t);
    fs.symlinkSync(os.tmpdir(), path.join(root, 'escape'));
    assert.throws(() => installRepositoryLinks({ repos: [{ repoName: 'Docs', destination: path.join(root, 'escape/link') }] }, options), /escapes/);
    assert.throws(() => removeRepositoryLinks([path.join(root, 'escape/link')], options), /escapes/);
    assert.throws(() => installRepositoryLinks({ repos: [
        { repoName: 'Docs', destination: path.join(root, 'valid') },
        { repoName: 'Docs', sourcePath: '../', destination: path.join(root, 'invalid') },
    ] }, options), /subdirectory/);
    assert.equal(fs.existsSync(path.join(root, 'valid')), false);
});


test('staged link idempotence uses the final runtime parent and preserves conflicts', t => {
    const { root } = fixture(t);
    const destination = path.join(root, 'stage/linked/Library');
    const options = { linkParent: '/Agent/linked' };
    assert.equal(ensureRepositoryLink(destination, '/workspace/Library', root, options).status, 'installed');
    assert.equal(fs.readlinkSync(destination), '../../workspace/Library');
    assert.equal(ensureRepositoryLink(destination, '/workspace/Library', root, options).status, 'present');
    assert.equal(ensureRepositoryLink(destination, '/workspace/Other', root, options).status, 'conflict');
    assert.equal(fs.readlinkSync(destination), '../../workspace/Library');
});
