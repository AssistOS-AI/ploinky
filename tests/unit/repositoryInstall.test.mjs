import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureRepositoryLink, installRepositoryLinks, removeRepositoryLinks } from '../../cli/utils/repositoryInstall.mjs';
import { syncManagedSkillExports } from '../../cli/utils/skills/managedExports.js';

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

// A portable alias whose depth differs from the real path must not change the
// link text: relative links are computed from the canonical final parent.
function unequalDepthAlias(t) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'repo-install-alias-')));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const real = path.join(base, 'deep', 'nested', 'real-workspace');
    fs.mkdirSync(real, { recursive: true });
    const alias = path.join(base, 'alias');
    fs.symlinkSync(real, alias, 'dir');
    const source = path.join(real, 'Docs');
    fs.mkdirSync(path.join(source, 'skills/example'), { recursive: true });
    fs.writeFileSync(path.join(source, 'skills/example/SKILL.md'), 'Aliased');
    return { base, real, alias, source };
}

test('unequal-depth workspace aliases publish links that resolve to the exact source', t => {
    const { real, alias, source } = unequalDepthAlias(t);
    const options = { workspaceRoot: alias, resolveRepository: () => ({ source: path.join(alias, 'Docs') }) };
    const robot = path.join(alias, 'robot');
    const input = { repos: [{ repoName: 'Docs', destination: path.join(robot, 'linked/docs') }],
        skillRepos: [{ repoName: 'Docs', destination: robot, skills: ['example'] }] };
    const first = installRepositoryLinks(input, options);
    assert.equal(first.conflicts.length, 0);
    assert.ok(first.results.every(entry => entry.status === 'installed'));
    // The published destinations are canonical, never alias spellings.
    assert.ok(first.results.every(entry => entry.destination.startsWith(`${real}${path.sep}`)));
    const second = installRepositoryLinks(input, options);
    assert.ok(second.results.every(entry => entry.status === 'present'), JSON.stringify(second.results));
    for (const root of [alias, real]) {
        assert.equal(fs.readFileSync(path.join(root, 'robot/.claude/skills/example/SKILL.md'), 'utf8'), 'Aliased');
        assert.equal(fs.readFileSync(path.join(root, 'robot/linked/docs/skills/example/SKILL.md'), 'utf8'), 'Aliased');
        assert.equal(fs.realpathSync(path.join(root, 'robot/.agents/skills/example')), path.join(source, 'skills/example'));
    }
    const link = path.join(alias, 'robot/.agents/skills/example');
    assert.equal(removeRepositoryLinks([link, path.join(real, 'robot/.agents/skills/example')], options).results.length, 1,
        'alias and canonical spellings name one destination');
    assert.equal(fs.existsSync(path.join(source, 'skills/example/SKILL.md')), true, 'removal never follows the final link');
});

test('ensureRepositoryLink canonicalizes an aliased root and keeps explicit runtime link parents', t => {
    const { real, alias, source } = unequalDepthAlias(t);
    const destination = path.join(alias, 'missing/descendant/link');
    const installed = ensureRepositoryLink(destination, source, alias);
    assert.equal(installed.status, 'installed');
    assert.equal(installed.destination, path.join(real, 'missing/descendant/link'));
    assert.equal(fs.realpathSync(destination), source);
    assert.equal(ensureRepositoryLink(destination, source, alias).status, 'present');
    const staged = path.join(alias, 'stage/linked/Library');
    const runtime = { linkParent: '/Agent/linked' };
    assert.equal(ensureRepositoryLink(staged, '/workspace/Library', alias, runtime).status, 'installed');
    assert.equal(fs.readlinkSync(staged), '../../workspace/Library');
    assert.equal(ensureRepositoryLink(staged, '/workspace/Library', alias, runtime).status, 'present');
    fs.symlinkSync(os.tmpdir(), path.join(real, 'escape'));
    assert.throws(() => ensureRepositoryLink(path.join(alias, 'escape/link'), source, alias), /escapes/);
    assert.throws(() => ensureRepositoryLink(alias, source, alias), /inside the workspace/);
});

test('marketplace removal preserves skill links owned by another exporter', t => {
    const { root, source, options } = fixture(t);
    const destination = path.join(root, 'robot');
    syncManagedSkillExports({ folder: destination, owner: 'manifest',
        sources: [{ name: 'example', path: path.join(source, 'skills/example') }] });
    const link = path.join(destination, '.agents/skills/example');
    const removed = removeRepositoryLinks([link], options);
    assert.equal(removed.results[0].status, 'conflict');
    assert.equal(removed.conflicts.length, 1);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'a manifest-owned link survives marketplace removal');
});

test('marketplace install owns only links it creates; unowned identical links survive removal', t => {
    const { root, source, options } = fixture(t);
    const destination = path.join(root, 'robot');
    const skills = path.join(destination, '.agents/skills');
    fs.mkdirSync(path.join(source, 'skills/other'), { recursive: true });
    fs.writeFileSync(path.join(source, 'skills/other/SKILL.md'), 'Other');
    fs.mkdirSync(skills, { recursive: true });
    fs.symlinkSync(path.relative(skills, path.join(source, 'skills/other')), path.join(skills, 'other'));
    const installed = installRepositoryLinks({ skillRepos: [{ repoName: 'Docs', destination, skills: ['example', 'other'] }] }, options);
    const byName = Object.fromEntries(installed.results.map(entry => [path.basename(entry.destination), entry.status]));
    assert.deepEqual(byName, { '.claude': 'installed', example: 'installed', other: 'present' });
    const ledger = JSON.parse(fs.readFileSync(path.join(destination, '.agents/.ploinky-skill-exports.json'), 'utf8'));
    assert.equal(ledger.entries.example.owner, 'marketplace');
    assert.equal(ledger.entries.other, undefined);
    const removed = removeRepositoryLinks([path.join(skills, 'example'), path.join(skills, 'other')], options);
    assert.deepEqual(removed.results.map(entry => entry.status), ['removed', 'conflict']);
    assert.equal(removed.results[1].reason, 'unrecorded-output-preserved');
    assert.ok(fs.lstatSync(path.join(skills, 'other')).isSymbolicLink());
});

test('removing a skill link from a folder that does not exist reports absent and still processes the batch', t => {
    const { root, options } = fixture(t);
    const link = path.join(root, 'plain-link');
    fs.symlinkSync(path.join(root, 'Docs'), link, 'dir');
    const result = removeRepositoryLinks([path.join(root, 'missing', '.agents', 'skills', 'x'), link], options);
    const byDestination = Object.fromEntries(result.results.map(entry => [path.basename(entry.destination), entry.status]));
    assert.equal(byDestination.x, 'absent');
    assert.equal(byDestination['plain-link'], 'removed');
});
